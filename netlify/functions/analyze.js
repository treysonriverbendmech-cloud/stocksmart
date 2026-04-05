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
          text: `Analyze this inventory item photo for an HVAC contractor's parts inventory system. Respond with ONLY a JSON object, no markdown, no code blocks.

Use exactly this structure:
{"name":"specific part name","category":"HVAC|Plumbing|Electrical|General","subcategory":"subcategory name","keywords":["keyword1","keyword2","keyword3"],"price":0.00,"notes":"brief description of item condition and key features","confidence":85}

Category and subcategory rules:
- HVAC subcategories: New Parts, Used Parts, Ductwork & Fittings, Air Distribution Devices, Filters / Air Quality, Motors & Compressors, Refrigerant & Chemicals, Thermostats & Controls, Pipes & Fittings, Other
- Plumbing subcategories: Pipes & Fittings, Rigging Material, Sealants & Adhesives, Rigging & Strapping, Other
- Electrical subcategories: Wire / Cables, Conduit & Fittings, Straps & Hanging, Breakers & Panels, Electrical Devices, Junction Boxes, Other
- General subcategories: Fasteners & Hardware, Safety Equipment, Consumables, Job Supplies, Other

Confidence (0-100): how certain you are about the identification. 90+ if very clear, 70-89 if mostly clear, 50-69 if uncertain, below 50 if very unclear.
Price: estimate fair used/retail value in USD, or 0 if unknown.
Keywords: 3-6 relevant search terms (brand, model, part number visible in image, material, size, etc.).`
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
