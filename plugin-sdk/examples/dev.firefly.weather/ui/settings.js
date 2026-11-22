const statusEl = document.getElementById("status");
const formEl = document.getElementById("key-form");
const inputEl = document.getElementById("api-key");
const clearBtn = document.getElementById("clear-btn");

async function callPlugin(method, params) {
  const bridge = window.fireflyPlugin;
  if (!bridge || typeof bridge.invoke !== "function") {
    throw new Error("window.fireflyPlugin 桥接不可用");
  }
  return await bridge.invoke(method, params);
}

async function refresh() {
  try {
    const res = await callPlugin("get_settings");
    statusEl.textContent = res.configured ? `已配置 API Key（${res.maskedKey}）` : "尚未配置 API Key（使用 Open-Meteo）";
  } catch (error) {
    statusEl.textContent = `读取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

formEl?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const res = await callPlugin("save_api_key", { apiKey: inputEl.value });
    if (!res.ok) {
      statusEl.textContent = res.error ?? "保存失败";
      return;
    }
    inputEl.value = "";
    statusEl.textContent = `已保存 API Key（${res.maskedKey}）`;
  } catch (error) {
    statusEl.textContent = `保存失败: ${error instanceof Error ? error.message : String(error)}`;
  }
});

clearBtn?.addEventListener("click", async () => {
  try {
    await callPlugin("clear_api_key");
    inputEl.value = "";
    statusEl.textContent = "已清除 API Key（使用 Open-Meteo）";
  } catch (error) {
    statusEl.textContent = `清除失败: ${error instanceof Error ? error.message : String(error)}`;
  }
});

void refresh();
