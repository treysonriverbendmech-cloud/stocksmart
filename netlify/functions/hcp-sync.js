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
    // First sync: go back 2 years to catch all history. After that, use lastSyncAt.
    const since = lastSyncAt ? new Date(lastSyncAt) : new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);

    let completedJobs = [];
    let page = 1;
    let totalPages = 1;

    do {
      const url = `${HCP_BASE}/jobs?page=${page}&page_size=100&sort_direction=desc`;
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
        totalPages = meta.total_pages || meta.last_page || meta.totalPages || 1;
        debugInfo.totalPages = totalPages;
        debugInfo.rawMeta = JSON.stringify(meta).substring(0, 300);
        debugInfo.rawDataKeys = JSON.stringify(Object.keys(data)).substring(0, 200);
        debugInfo.jobsOnPage1 = jobs.length;
        // Always capture the first job's raw structure regardless of date filter
        // This lets us see field names even when all jobs are "already processed"
        const anyJob = jobs[0];
        if (anyJob) {
          debugInfo.rawJobKeys  = JSON.stringify(Object.keys(anyJob)).substring(0, 500);
          debugInfo.rawJobSample = JSON.stringify(anyJob).substring(0, 1200);
          debugInfo.resolvedJobNum = anyJob.job_number ?? anyJob.number ?? anyJob.custom_job_number ?? anyJob.invoice_number ?? '(none)';
          debugInfo.resolvedTech = anyJob.schedule?.dispatched_employees
            ? JSON.stringify(anyJob.schedule.dispatched_employees).substring(0, 300)
            : (anyJob.assigned_employees ? JSON.stringify(anyJob.assigned_employees).substring(0, 300) : '(no emp field on list endpoint)');
        }
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

    // ── 2. Fetch line items AND full job detail in batches of 5 ─────────────
    // Individual job endpoint returns schedule.dispatched_employees (tech names)
    // and a confirmed job_number — things the list endpoint often omits.
    const fullJobs = [];
    const BATCH = 5;
    for (let i = 0; i < completedJobs.length; i += BATCH) {
      const chunk = completedJobs.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map(async job => {
        try {
          // Fetch line items and individual job detail in parallel
          const [liResp, detailResp] = await Promise.all([
            fetch(`${HCP_BASE}/jobs/${job.id}/line_items`, { headers }),
            fetch(`${HCP_BASE}/jobs/${job.id}`, { headers }),
          ]);

          // Parse line items
          let parsedLineItems = [];
          if (liResp.ok) {
            try {
              const liData = await liResp.json();
              parsedLineItems = liData.data || liData.line_items || (Array.isArray(liData) ? liData : []);
            } catch(e) {}
          }

          // Merge individual job detail on top of list data (detail is more complete)
          let merged = { ...job };
          if (detailResp.ok) {
            try {
              const detail = await detailResp.json();
              // detail may be the job object directly, or wrapped
              const detailJob = detail.id ? detail : (detail.job || detail.data || detail);
              merged = { ...job, ...detailJob };
            } catch(e) {}
          }

          return { ...merged, line_items: parsedLineItems };
        } catch(e) {
          return { ...job, line_items: [] };
        }
      }));
      fullJobs.push(...results);
    }

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

    // Debug: capture a raw job sample — use completedJobs as fallback if fullJobs is empty
    const sampleJob = fullJobs[0] || completedJobs[0] || null;
    if (sampleJob) {
      debugInfo.rawJobKeys   = JSON.stringify(Object.keys(sampleJob)).substring(0, 500);
      debugInfo.rawJobSample = JSON.stringify(sampleJob).substring(0, 1200);
      // Highlight exactly what we resolved for this job
      debugInfo.resolvedJobNum  = sampleJob.job_number ?? sampleJob.number ?? sampleJob.custom_job_number ?? sampleJob.invoice_number ?? '(none found)';
      debugInfo.resolvedTech    = sampleJob.schedule?.dispatched_employees
        ? JSON.stringify(sampleJob.schedule.dispatched_employees).substring(0, 300)
        : (sampleJob.assigned_employees ? JSON.stringify(sampleJob.assigned_employees).substring(0, 300) : '(no employee field found)');
    }

    for (const job of fullJobs) {
      // Try every known HCP field name for the human-readable job number
      const jobNum = job.job_number || job.number || job.custom_job_number
                   || job.invoice_number || job.work_order_number
                   || (job.id ? String(job.id).replace(/^job_/i, '#') : 'Unknown');

      // Try every known field name for assigned technicians.
      // HCP individual-job endpoint puts employees in schedule.dispatched_employees.
      const schedEmp = (job.schedule?.dispatched_employees)
                    || (job.schedule?.employees)
                    || [];
      const empArray = job.assigned_employees || job.assigned_employee
                     || job.employees || job.technicians || job.pros
                     || schedEmp;
      const empList  = Array.isArray(empArray) ? empArray
                     : (empArray ? [empArray] : []);
      // Also check schedEmp even if empArray came from another field
      const allEmps  = [...empList, ...(Array.isArray(schedEmp) ? schedEmp : [])];
      const uniqueEmps = allEmps.filter((e, i, arr) =>
        e && arr.findIndex(x => x === e || (x?.id && x.id === e?.id)) === i
      );
      const tech     = uniqueEmps
        .map(e => e ? (e.full_name || e.name || `${e.first_name||''} ${e.last_name||''}`.trim()) : '')
        .filter(Boolean).join(', ')
        || (job.pro ? (job.pro.full_name || job.pro.name || '') : '')
        || 'Unknown';

      const completedAt = job.completed_at || job.updated_at || new Date().toISOString();
      const lineItems   = job.line_items || job.materials || job.invoice_items || [];

      for (const item of lineItems) {
        const kind = (item.kind || item.type || '').toLowerCase();
        const nameRaw = item.name || item.description || '';
        const nameCheck = nameRaw.toLowerCase();

        // Skip non-material kinds (service_charge = labor in HCP)
        if (kind === 'labor' || kind === 'service_charge' || kind === 'discount' || kind === 'tax' || kind === 'fee') continue;

        // Skip by name pattern — tax codes, discounts, and clearly labor items
        if (/^[a-z]{2}-\s/.test(nameRaw)) continue; // state tax codes like "AR- Arkansas"
        if (nameCheck.includes('sales tax') || nameCheck.includes('tax rate') || kind.includes('tax')) continue;
        if (nameCheck.includes('discount') || nameCheck.startsWith('- ') || (item.unit_price < 0)) continue;

        // Skip labor-named items that somehow slip through as 'material' kind
        const laborWords = ['labor', 'service call', 'service fee', 'trip charge', 'diagnostic', 'dispatch fee', 'hourly rate', 'maintenance agreement', 'tune up', 'tune-up'];
        if (laborWords.some(w => nameCheck.includes(w))) continue;

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
            jobNumber:   jobNum,
            jobId:       job.id,
            itemName,
            partNumber:  partNum || '—',
            hcpUuid:     materialUuid || '',
            quantity:    qty,
            unitPrice,
            tech,
            completedAt,
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
