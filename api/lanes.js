// Vercel Function: what the demo page asks first. `mock` is true when the deployment has
// no key of its own, so the page can say it's showing a sample unless you bring a key.

import { LANES } from '../src/lanes.js';

export function GET() {
  return Response.json({
    mock: !process.env.ASSEMBLYAI_API_KEY,
    hosted: true,
    lanes: LANES.map(({ id, name, blurb, transform }) => ({ id, name, blurb, transform }))
  });
}
