// Housecall Pro → Partlocker sync function
// Polls HCP API for completed jobs, matches line items to Partlocker inventory,
// creates pending deductions for user approval.
//
// Called by: POST /.netlify/functions/hcp-sync
// Body: { apiKey, lastSyncAt (ISO string, optional) }

const HCP_BASE = 'https://api.housecallpro.com';

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
    // ── 1. Fetch recently completed jobs ─────────────────────────────────────
    // HCP API: GET /jobs?page=1&per_page=100&work_status=completed
    // If lastSyncAt provided, only fetch jobs updated after that date
    const since = lastSyncAt ? new Date(lastSyncAt) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const sinceStr = since.toISOString().split('T')[0]; // YYYY-MM-DD

    let allJobs = [];
    let page = 1;
    let totalPages = 1;

    do {
      const url = `${HCP_BASE}/jobs?page=${page}&per_page=100&work_status=complete&sort_direction=desc`;
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

      // Log raw shape on first page to help debug response structure
      if (page === 1) {
        console.log('HCP jobs response keys:', Object.keys(data));
        if (data.jobs && data.jobs[0]) {
          console.log('First job keys:', Object.keys(data.jobs[0]));
          if (data.jobs[0].line_items) {
            console.log('First line item keys:', Object.keys(data.jobs[0].line_items[0] || {}));
          }
        }
      }

      const jobs = data.jobs || data.data || data.results || [];
      const meta = data.meta || data.pagination || {};
      totalPages = meta.total_pages || meta.last_page || 1;

      // Only include jobs updated after our last sync
      const newJobs = jobs.filter(j => {
        const updatedAt = j.updated_at || j.completed_at || j.schedule?.end;
        if (!updatedAt) return true;
        return new Date(updatedAt) > since;
      });

      allJobs = allJobs.concat(newJobs);
      page++;

      // Stop if we've gone past jobs updated after lastSync
      if (newJobs.length < jobs.length) break;

    } while (page <= totalPages && page <= 10); // cap at 10 pages = 1000 jobs

    // ── 2. Build lookup map of Partlocker parts by hcpUuid and partNumber ────
    // Parts are passed in from the client (already loaded in app)
    const partsByHcpUuid   = {};
    const partsByPartNumber = {};
    (parts || []).forEach(p => {
      if (p.hcpUuid)     partsByHcpUuid[p.hcpUuid]         = p;
      if (p.partNumber)  partsByPartNumber[p.partNumber.trim().toUpperCase()] = p;
    });

    // ── 3. Match line items to Partlocker parts ───────────────────────────────
    const pending   = [];
    const unmatched = [];

    for (const job of allJobs) {
      const jobNum  = job.job_number || job.id || 'Unknown';
      const tech    = (job.assigned_employees || []).map(e => e.name || e.full_name || '').filter(Boolean).join(', ') || 'Unknown';
      const completedAt = job.completed_at || job.updated_at || new Date().toISOString();

      const lineItems = job.line_items || job.materials || [];

      for (const item of lineItems) {
        // Skip non-material items (service charges, labor, etc.)
        const kind = item.kind || item.type || item.line_item_type || '';
        if (kind && !['material', 'part', 'product', ''].includes(kind.toLowerCase())) continue;

        // Try matching by HCP pricebook UUID first, then part number
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
          // Log unmatched items for review
          unmatched.push({
            jobNumber: jobNum,
            itemName,
            partNumber: partNum || materialUuid || '—',
            quantity:  qty,
          });
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok:         true,
        jobsScanned: allJobs.length,
        pending,
        unmatched,
        syncedAt:   new Date().toISOString(),
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
