// 聊天渲染基线的录像辅助：固定视口、录像文件命名，以及录像期间自动跟随流式消息。

/** 录像统一使用的视口与视频尺寸。 */
export const VIDEO_SIZE = { width: 1440, height: 900 };

/** 只有给出录像目录时才开启固定视口与视频录制，否则不改变浏览器上下文选项。 */
export function createRecordingContextOptions(recordVideoDir) {
  return recordVideoDir
    ? { viewport: VIDEO_SIZE, recordVideo: { dir: recordVideoDir, size: VIDEO_SIZE } }
    : {};
}

/** 录像文件名：数据集、条数、滚动方式、流式渲染模式与第几次运行。 */
export function recordingFileName({ dataset, count, scroll, streamRender }, runNumber) {
  const render = streamRender ?? "animated";
  return `${dataset}-${count}-${scroll}-${render}-run-${runNumber}.webm`;
}

/**
 * 仅录像时通过 addInitScript 注入页面：每帧检查，一旦进入 streaming 状态
 * 就把消息列表滚到底，让画面始终停在正在增长的最后一条消息上。
 * 这个函数会被序列化后送进页面，所以不能引用外部变量。
 */
export function installLiveMessageFollow() {
  const stickToBottom = () => {
    const streaming = globalThis.window?.__perfState === "streaming";
    const list = streaming ? globalThis.document.querySelector(".ff-message-list") : null;
    if (list) list.scrollTop = list.scrollHeight;
    globalThis.requestAnimationFrame(stickToBottom);
  };
  globalThis.requestAnimationFrame(stickToBottom);
}
