// Housecall Pro → Partlocker sync function
// Polls HCP API for completed jobs, matches line items to Partlocker inventory,
// creates pending deductions for user approval.
//
// Called by: POST /.netlify/functions/hcp-sync
// Body: { apiKey, lastSyncAt (ISO string, optional), parts[] }

const HCP_BASE = 'https://api.housecallpro.com';

// HCP uses "complete unrated" and "complete rated" for finished jobs
const DONE_STATUSES = new Set(['complete unrated', 'complete rated', 'complete', 'invoiced', 'paid']);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { apiKey, lastSyncAt, parts } = body;
  if (!apiKey) return { statusCode: 400, body: JSON.stringify({ error: 'Missing apiKey' }) };

  const headers = {
    'Authorization': `Token ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  try {
    const debugInfo = {};

    // ── 1. Fetch jobs (all statuses, filter to completed ones) ────────────────
    const since = lastSyncAt ? new Date(lastSyncAt) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    let completedJobs = [];
    let page = 1;
    let totalPages = 1;

    do {
      const url = `${HCP_BASE}/jobs?page=${page}&per_page=100&sort_direction=desc`;
      const resp = await fetch(url, { headers });

      if (!resp.ok) {
        const errText = await resp.text();
        return {
          statusCode: resp.status,
          body: JSON.stringify({
            error: `HCP API error: ${resp.status} ${resp.statusText}`,
            detail: errText.substring(0, 500),
            hint: resp.status === 401 ? 'Check your API key' : resp.status === 403 ? 'API access may require MAX plan' : ''
          })
        };
      }

      const data = await resp.json();
      const jobs = data.jobs || data.data || data.results || [];
      const meta = data.meta || data.pagination || {};
      totalPages = meta.total_pages || meta.last_page || 1;

      // Log pagination info on first page
      if (page === 1) {
        debugInfo.totalPages = totalPages;
        debugInfo.metaSample = JSON.stringify(meta).substring(0, 200);
        debugInfo.jobsOnPage1 = jobs.length;
      }

      // Keep only completed jobs updated since our cutoff
      const newDone = jobs.filter(j => {
        const status = (j.work_status || j.status || '').toLowerCase();
        if (!DONE_STATUSES.has(status)) return false;
        const updatedAt = j.updated_at || j.completed_at || j.schedule?.end;
        if (!updatedAt) return true;
        return new Date(updatedAt) > since;
      });

      completedJobs = completedJobs.concat(newDone);
      page++;

      // Stop only if jobs are sorted newest-first and oldest on this page is before our cutoff
      const oldestOnPage = jobs[jobs.length - 1];
      const oldestDate = oldestOnPage && (oldestOnPage.updated_at || oldestOnPage.completed_at || oldestOnPage.schedule?.end);
      if (oldestDate && new Date(oldestDate) < since) break;

    } while (page <= totalPages && page <= 20); // up to 20 pages = 2000 jobs

    // ── 2. Fetch line items via GET /jobs/{id}/line_items ─────────────────────
    const fullJobs = await Promise.all(
      completedJobs.map(async job => {
        try {
          const liResp = await fetch(`${HCP_BASE}/jobs/${job.id}/line_items`, { headers });
          if (!liResp.ok) return { ...job, line_items: [] };
          const liData = await liResp.json();
          // Response shape: { object: "list", data: [...] }
          const lineItems = liData.data || liData.line_items || (Array.isArray(liData) ? liData : []);
          return { ...job, line_items: lineItems };
        } catch(e) {
          return { ...job, line_items: [] };
        }
      })
    );

    // ── 3. Build lookup maps from Partlocker parts ────────────────────────────
    const partsByHcpUuid   = {};
    const partsByPartNumber = {};
    (parts || []).forEach(p => {
      if (p.hcpUuid)    partsByHcpUuid[p.hcpUuid]                          = p;
      if (p.partNumber) partsByPartNumber[p.partNumber.trim().toUpperCase()] = p;
    });

    // ── 4. Match line items to Partlocker parts ───────────────────────────────
    const pending   = [];
    const unmatched = [];

    for (const job of fullJobs) {
      const jobNum      = job.job_number || job.id || 'Unknown';
      const tech        = (job.assigned_employees || []).map(e => e.name || e.full_name || '').filter(Boolean).join(', ') || 'Unknown';
      const completedAt = job.completed_at || job.updated_at || new Date().toISOString();
      const lineItems   = job.line_items || job.materials || job.invoice_items || [];

      for (const item of lineItems) {
        // Skip labor and other non-material line items
        const kind = (item.kind || item.type || '').toLowerCase();
        if (kind === 'labor' || kind === 'service_charge' || kind === 'discount') continue;

        // service_item_id is the pricebook UUID (pbmat_... for materials)
        const materialUuid = item.service_item_id || item.material_uuid || item.pricebook_material_id || '';
        const partNum      = (item.part_number || item.sku || '').trim().toUpperCase();
        const itemName     = item.name || item.description || 'Unknown';
        const qty          = parseFloat(item.quantity || 1);
        // HCP returns prices in cents
        const unitPrice    = parseFloat(item.unit_price || 0) / 100;

        let matched = null;
        let matchType = '';

        if (materialUuid && partsByHcpUuid[materialUuid]) {
          matched   = partsByHcpUuid[materialUuid];
          matchType = 'hcpUuid';
        } else if (partNum && partsByPartNumber[partNum]) {
          matched   = partsByPartNumber[partNum];
          matchType = 'partNumber';
        }

        if (matched) {
          pending.push({
            jobId:       job.id,
            jobNumber:   jobNum,
            tech,
            completedAt,
            partId:      matched.id,
            partName:    matched.name,
            hcpItemName: itemName,
            hcpUuid:     materialUuid,
            partNumber:  matched.partNumber || partNum,
            quantity:    qty,
            unitPrice,
            matchType,
            currentQty:  matched.quantity || 0,
            status:      'pending',
          });
        } else if (itemName && itemName !== 'Unknown') {
          unmatched.push({
            jobNumber: jobNum,
            itemName,
            partNumber: partNum || materialUuid || '—',
            quantity:  qty,
          });
        }
      }
    }

    // Debug: grab first line item sample for troubleshooting
    const firstJobWithItems = fullJobs.find(j => (j.line_items || j.materials || j.invoice_items || []).length > 0);
    const sampleLineItem = firstJobWithItems
      ? (firstJobWithItems.line_items || firstJobWithItems.materials || firstJobWithItems.invoice_items || [])[0]
      : null;

    const statusesSeen = [...new Set(completedJobs.map(j => j.work_status || j.status || 'unknown'))];

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok:          true,
        jobsScanned: completedJobs.length,
        statusesSeen,
        pending,
        unmatched,
        debugInfo,
      debugLineItem: sampleLineItem ? JSON.stringify(sampleLineItem).substring(0, 600) : 'no line items found',
        syncedAt:    new Date().toISOString(),
      })
    };

  } catch (err) {
    console.error('hcp-sync error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
