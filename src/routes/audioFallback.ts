import { Hono } from "hono";

const audioFallbackRoute = new Hono();

// YouTube audio extraction is handled client-side via YouTube IFrame Player API.
// This route file is kept for future use.

export default audioFallbackRoute;
