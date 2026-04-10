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

  let imageBase64, mediaType, mode;
  try {
    ({ imageBase64, mediaType, mode } = JSON.parse(event.body));
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad request body: ' + e.message }) };
  }

  // ── Receipt mode prompt ───────────────────────────────────────────────────
  const receiptPrompt = `You are scanning a supply house receipt for an HVAC contractor's inventory system.
Extract every line item from this receipt and return ONLY a JSON object, no markdown, no code blocks.

Use exactly this structure:
{"items":[{"partNumber":"HC21ZE121","name":"Carrier Capacitor 45/5 MFD","description":"Dual run capacitor 45/5 MFD 370V oval, fits Carrier and Bryant units","quantity":2,"price":12.50,"category":"HVAC","subcategory":"Motors & Compressors","keywords":["capacitor","carrier","45/5","dual run","370v"]},{"partNumber":"","name":"1/2 Copper Fitting","description":"1/2 inch copper sweat elbow 90 degree","quantity":10,"price":1.25,"category":"Plumbing","subcategory":"Pipes & Fittings","keywords":["copper","fitting","elbow","1/2"]}]}

Rules:
- Extract the part number exactly as printed (it may be labeled SKU, Item#, Part#, Model, etc.)
- If no part number is visible for a line, leave partNumber as empty string ""
- name: full descriptive name including brand, size, rating, and model if visible on receipt
- description: expand the name with ALL additional detail visible on the receipt line — voltage ratings, dimensions, compatibility, material, color, etc. If nothing extra is available, repeat the name.
- quantity: number of units on that line
- price: unit price (not extended/total price)
- category must be one of: HVAC, Plumbing, Electrical, General
- HVAC subcategories: New Parts, Used Parts, Ductwork & Fittings, Air Distribution Devices, Filters / Air Quality, Motors & Compressors, Refrigerant & Chemicals, Thermostats & Controls, Pipes & Fittings, Other
- Plumbing subcategories: Pipes & Fittings, Rigging Material, Sealants & Adhesives, Rigging & Strapping, Other
- Electrical subcategories: Wire / Cables, Conduit & Fittings, Straps & Hanging, Breakers & Panels, Electrical Devices, Junction Boxes, Other
- General subcategories: Fasteners & Hardware, Safety Equipment, Consumables, Job Supplies, Other
- keywords: 3-6 search terms including brand, size, model number, and material
- Skip tax lines, shipping lines, totals, and header rows — only include actual parts/items
- If the image is not a receipt or no items are visible, return {"items":[]}`;

  // ── Single part mode prompt ───────────────────────────────────────────────
  const partPrompt = `Analyze this inventory item photo for an HVAC contractor's parts inventory system. Respond with ONLY a JSON object, no markdown, no code blocks.

Use exactly this structure:
{"name":"specific part name","category":"HVAC|Plumbing|Electrical|General","subcategory":"subcategory name","keywords":["keyword1","keyword2","keyword3"],"price":0.00,"notes":"brief description of item condition and key features","confidence":85}

Category and subcategory rules:
- HVAC subcategories: New Parts, Used Parts, Ductwork & Fittings, Air Distribution Devices, Filters / Air Quality, Motors & Compressors, Refrigerant & Chemicals, Thermostats & Controls, Pipes & Fittings, Other
- Plumbing subcategories: Pipes & Fittings, Rigging Material, Sealants & Adhesives, Rigging & Strapping, Other
- Electrical subcategories: Wire / Cables, Conduit & Fittings, Straps & Hanging, Breakers & Panels, Electrical Devices, Junction Boxes, Other
- General subcategories: Fasteners & Hardware, Safety Equipment, Consumables, Job Supplies, Other

Confidence (0-100): how certain you are about the identification. 90+ if very clear, 70-89 if mostly clear, 50-69 if uncertain, below 50 if very unclear.
Price: estimate fair used/retail value in USD, or 0 if unknown.
Keywords: 3-6 relevant search terms (brand, model, part number visible in image, material, size, etc.).`;

  const isReceipt = mode === 'receipt';
  const maxTokens = isReceipt ? 2048 : 512;

  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 }
        },
        {
          type: 'text',
          text: isReceipt ? receiptPrompt : partPrompt
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
        console.log('Anthropic status:', res.statusCode, '| mode:', mode || 'part');
        console.log('Anthropic response:', raw.slice(0, 400));

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
