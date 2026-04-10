const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  }

  let query;
  try {
    ({ query } = JSON.parse(event.body));
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad request body: ' + e.message }) };
  }

  if (!query || !query.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No query provided' }) };
  }

  const prompt = `You are a search assistant for an HVAC contractor parts inventory app called Partlocker.
A technician has typed a natural language search query. Convert it into structured search parameters.

Available categories and subcategories:
- HVAC: New Parts, Used Parts, Ductwork & Fittings, Air Distribution Devices, Filters / Air Quality, Motors & Compressors, R-410A, R-22, R-32, R-454B, R-407C, R-404A, Thermostats & Controls, Pipes & Fittings, Other
- Plumbing: Pipes & Fittings, Rigging Material, Sealants & Adhesives, Rigging & Strapping, Other
- Electrical: Wire / Cables, Conduit & Fittings, Straps & Hanging, Breakers & Panels, Electrical Devices, Junction Boxes, Other
- General: Fasteners & Hardware, Safety Equipment, Consumables, Job Supplies, Other
- Chemicals: Coil Cleaner, Evap Coil Cleaner, Condenser Coil Cleaner, Refrigerant Oil, Flush & Solvent, Leak Stop / Sealant, Drain Treatment, Other Chemicals

Common HVAC knowledge to apply:
- "hard start kit" = start capacitor/relay, subcategory: Motors & Compressors
- "cap", "capacitor", "dual run", "run cap" = Motors & Compressors
- "contactor", "relay" = Motors & Compressors or Thermostats & Controls
- "thermostat", "tstat", "t-stat" = Thermostats & Controls
- "filter", "air filter", "1 inch", "4 inch" = Filters / Air Quality
- "refrigerant", "freon", "410a", "r22" = match the refrigerant subcategory
- "drain pan", "float switch" = HVAC Other or Thermostats & Controls
- "blower motor", "condenser fan", "motor" = Motors & Compressors
- "copper", "lineset" = Pipes & Fittings
- "coil cleaner", "nu-brite" = Chemicals

Return ONLY a valid JSON object with no markdown, no explanation:
{
  "keywords": ["term1", "term2", "term3"],
  "category": "HVAC",
  "subcategory": "Motors & Compressors",
  "summary": "Searching for hard start kits and start capacitors"
}

Rules:
- keywords: 2-5 terms, include common alternate names and abbreviations techs actually use
- category: exact match from the list above, or "" if unclear
- subcategory: exact match from the list above, or "" if unclear
- summary: one short friendly sentence describing what you're looking for (10 words max)
- If the query mentions a van or location like "van 2" or "truck", set keywords to include the location name and leave category/subcategory empty

Technician query: "${query.replace(/"/g, '\\"')}"`;

  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }]
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
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        console.log('AI search status:', res.statusCode, '| query:', query);

        if (res.statusCode !== 200) {
          resolve({ statusCode: 502, body: JSON.stringify({ error: 'Anthropic error', status: res.statusCode }) });
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          const text = parsed.content[0].text;
          const match = text.match(/\{[\s\S]*\}/);
          if (!match) throw new Error('No JSON in response');
          // Validate the response has expected fields
          const result = JSON.parse(match[0]);
          if (!result.keywords || !Array.isArray(result.keywords)) throw new Error('Invalid response shape');
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(result),
          });
        } catch (e) {
          console.error('Parse error:', e.message, '| raw:', raw.slice(0, 200));
          resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
        }
      });
    });

    req.on('error', e => {
      resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
    });

    req.write(payload);
    req.end();
  });
};
