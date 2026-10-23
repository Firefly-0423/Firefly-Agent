export { setUserTimezoneConfig, currentUserTimezone } from "./builtin-tools/timezone";
export { setWeatherConfig, type WeatherCardData } from "./builtin-tools/weather-tool";
export { setSearchConfig } from "./builtin-tools/web-search-tool";

import { toolRegistry } from "./registry/tool-registry";
import { logger, LogTag } from "../../logger";
import { weatherTool } from "./builtin-tools/weather-tool";
import { webSearchTool } from "./builtin-tools/web-search-tool";
import { fetchUrlTool } from "./builtin-tools/fetch-url-tool";
import { downloadFileTool } from "./builtin-tools/download-file-tool";
import { readImageUrlTool } from "./builtin-tools/read-image-url-tool";
import { installMcpServerTool } from "./builtin-tools/install-mcp-tool";
import { runVerificationTool } from "./builtin-tools/run-verification-tool";
import { runShellTool } from "./builtin-tools/run-shell-tool";
import { shellJobTool } from "./builtin-tools/shell-job-tool";

// 注册次序同时决定模型看到的目录次序。
for (const definition of [
  fetchUrlTool, downloadFileTool, readImageUrlTool, runShellTool,
  shellJobTool, runVerificationTool, installMcpServerTool,
]) {
  toolRegistry.register(definition);
}
logger.info(LogTag.BuiltinTools, "registered: fetch_url / download_file / run_shell / install_mcp_server");
for (const definition of [weatherTool, webSearchTool]) toolRegistry.register(definition);
