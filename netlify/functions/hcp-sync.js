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

      // Capture raw first job from list for debugging
      if (page === 1 && jobs[0] && !debugInfo.rawFirstJob) {
        debugInfo.rawFirstJob = JSON.stringify(jobs[0]).substring(0, 1200);
        debugInfo.firstJobId = jobs[0].id || jobs[0].job_id || 'unknown';
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

      // If no jobs on this page matched our date range, stop paginating
      const anyInRange = jobs.some(j => {
        const updatedAt = j.updated_at || j.completed_at || j.schedule?.end;
        return !updatedAt || new Date(updatedAt) > since;
      });
      if (!anyInRange) break;

    } while (page <= totalPages && page <= 10);

    // ── 2. Fetch line items for each completed job ────────────────────────────
    // Job list doesn't include line items. Try three approaches per job:
    //   A) GET /jobs/{id}/line_items  (nested sub-resource)
    //   B) GET /invoices?job_id={id}  (invoice lookup by job)
    //   C) GET /invoices?invoice_number={n} (invoice lookup by number)
    const fullJobs = await Promise.all(
      completedJobs.map(async job => {
        try {
          let lineItems = [];

          // Approach A: line_items as sub-resource on job
          const liResp = await fetch(`${HCP_BASE}/jobs/${job.id}/line_items`, { headers });
          if (liResp.ok) {
            const liData = await liResp.json();
            lineItems = liData.line_items || liData.data || liData.results || (Array.isArray(liData) ? liData : []);
            if (!debugInfo.approachA) debugInfo.approachA = `status:${liResp.status} keys:${JSON.stringify(Object.keys(liData))} sample:${JSON.stringify(liData).substring(0,300)}`;
          } else {
            if (!debugInfo.approachA) debugInfo.approachA = `status:${liResp.status}`;
          }

          // Approach B: search invoices by job_id
          if (!lineItems.length) {
            const invResp = await fetch(`${HCP_BASE}/invoices?job_id=${job.id}`, { headers });
            if (invResp.ok) {
              const invData = await invResp.json();
              const invoices = invData.invoices || invData.data || invData.results || [];
              lineItems = invoices.flatMap(inv => inv.line_items || inv.items || []);
              if (!debugInfo.approachB) debugInfo.approachB = `status:${invResp.status} invoiceCount:${invoices.length} sample:${JSON.stringify(invData).substring(0,300)}`;
            } else {
              if (!debugInfo.approachB) debugInfo.approachB = `status:${invResp.status}`;
            }
          }

          // Approach C: search invoices by invoice_number
          if (!lineItems.length && job.invoice_number) {
            const invResp = await fetch(`${HCP_BASE}/invoices?invoice_number=${job.invoice_number}`, { headers });
            if (invResp.ok) {
              const invData = await invResp.json();
              const invoices = invData.invoices || invData.data || invData.results || [];
              lineItems = invoices.flatMap(inv => inv.line_items || inv.items || []);
              if (!debugInfo.approachC) debugInfo.approachC = `status:${invResp.status} invoiceCount:${invoices.length} sample:${JSON.stringify(invData).substring(0,300)}`;
            } else {
              if (!debugInfo.approachC) debugInfo.approachC = `status:${invResp.status}`;
            }
          }

          return { ...job, line_items: lineItems };
        } catch(e) {
          if (!debugInfo.fetchError) debugInfo.fetchError = e.message;
          return job;
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
        // Skip non-material items (service charges, labor, etc.)
        const kind = (item.kind || item.type || item.line_item_type || '').toLowerCase();
        if (kind && !['material', 'part', 'product', 'equipment', ''].includes(kind)) continue;

        const materialUuid = item.material_uuid || item.pricebook_material_id ||
                             item.material?.uuid || item.pricebook_item?.uuid || '';
        const partNum      = (item.part_number || item.sku || item.material?.part_number || '').trim().toUpperCase();
        const itemName     = item.name || item.description || item.material?.name || 'Unknown';
        const qty          = parseFloat(item.quantity || item.qty || 1);
        const unitPrice    = parseFloat(item.unit_price || item.price || 0);

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
