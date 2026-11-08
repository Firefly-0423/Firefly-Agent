// Read the launch flag once, when the main-process environment module loads.
const { VITE_DEV: developmentFlag } = process.env;

export const isDev = developmentFlag === "1";
