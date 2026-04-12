// Validate beta invite code — code lives in Netlify env, never exposed to browser
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { code } = body;
  if (!code) return { statusCode: 400, body: JSON.stringify({ valid: false, error: 'No code provided' }) };

  // BETA_INVITE_CODE is set in Netlify → Site settings → Environment variables
  // You can set multiple codes by separating with commas: CODE1,CODE2,CODE3
  const validCodes = (process.env.BETA_INVITE_CODE || '')
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter(Boolean);

  const isValid = validCodes.includes(code.trim().toLowerCase());

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valid: isValid })
  };
};
