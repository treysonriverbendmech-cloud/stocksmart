const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  console.log('Key length:', apiKey.length, '| First 10:', apiKey.slice(0, 10));

  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  }

  let imageBase64, mediaType;
  try {
    ({ imageBase64, mediaType } = JSON.parse(event.body));
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad request body: ' + e.message }) };
  }

  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 }
        },
        {
          type: 'text',
          text: 'Analyze this inventory item photo. Respond with ONLY a JSON object, no markdown:\n{"name":"item name","category":"Electronics|Furniture|Clothing|Tools|Food|Books|Sports|Toys|Kitchen|Office|Other","price":0.00,"notes":"brief description"}'
        }
      ]
    }]
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        console.log('Anthropic status:', res.statusCode);
        console.log('Anthropic response:', raw.slice(0, 300));

        if (res.statusCode !== 200) {
          resolve({ statusCode: 502, body: JSON.stringify({ error: 'Anthropic error', status: res.statusCode, detail: raw }) });
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          const text = parsed.content[0].text;
          const match = text.match(/\{[\s\S]*\}/);
          if (!match) throw new Error('No JSON in response: ' + text);
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: match[0],
          });
        } catch (e) {
          resolve({ statusCode: 500, body: JSON.stringify({ error: e.message, raw }) });
        }
      });
    });

    req.on('error', (e) => {
      console.error('HTTPS request error:', e.message);
      resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
    });

    req.write(payload);
    req.end();
  });
};
