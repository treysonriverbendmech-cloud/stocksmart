// notify-admin.js
// Sends an email to the company admin when a new tech requests access.
//
// Called by: POST /.netlify/functions/notify-admin
// Body: { adminEmail, adminName, techName, techEmail, companyName, appUrl }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'RESEND_API_KEY not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { adminEmail, adminName, techName, techEmail, companyName, appUrl } = body;
  if (!adminEmail || !techName || !techEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const approveUrl = appUrl || 'https://getpartlocker.com/app';
  const displayCompany = companyName || 'your company';
  const displayAdmin = adminName || 'there';

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
      <div style="margin-bottom:24px">
        <img src="https://getpartlocker.com/logo.png" alt="Partlocker" style="height:36px" onerror="this.style.display='none'">
        <span style="font-size:20px;font-weight:700;color:#6366f1;margin-left:8px">Partlocker</span>
      </div>
      <h2 style="color:#111;margin-bottom:8px">New access request</h2>
      <p style="color:#555;margin-bottom:20px">Hi ${adminName || 'there'},</p>
      <p style="color:#555;margin-bottom:20px">
        <strong>${techName}</strong> (${techEmail}) has requested access to
        <strong>${displayCompany}</strong> on Partlocker and is waiting for your approval.
      </p>
      <a href="${approveUrl}"
         style="display:inline-block;background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-bottom:24px">
        Review &amp; Approve →
      </a>
      <p style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:16px;margin-top:8px">
        Go to Settings → Team inside Partlocker to approve or deny this request.
      </p>
    </div>
  `;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Partlocker <notifications@getpartlocker.com>',
        to: [adminEmail],
        subject: `${techName} is requesting access to ${displayCompany} on Partlocker`,
        html,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return { statusCode: 500, body: JSON.stringify({ error: 'Email send failed', detail: err }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
