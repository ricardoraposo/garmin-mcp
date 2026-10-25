// Vercel Function entry point. `npm run build` compiles src/ to dist/ first.
// No secrets live here: each request brings its own Garmin Personal API key.
import { createHttpHandlerFromEnv } from "../dist/http.js";

const handler = createHttpHandlerFromEnv();

export default { fetch: handler };
