const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const root = path.resolve(process.argv[2] ?? path.join(__dirname, '../../output/renderer-layout-qa'));
const isolation = path.join(root, 'profile');
fs.mkdirSync(isolation, { recursive: true });
const sessionDir = path.join(isolation, 'Firefly-smoke', 'firefly-chats', 'sessions');
fs.mkdirSync(sessionDir, { recursive: true });
const now = Date.now();
const fixture = (id, mode, title, extra = {}) => ({ id, mode, title, schemaVersion: 1, identityId: null, createdAt: now - 100000, updatedAt: now, messages: [
  { id: id + '-u1', role: 'user', content: '这是保存于旧版本的会话。请保留历史。', at: now - 10000 },
  { id: id + '-m1', role: 'model', content: '历史消息保持可读。\n\n这份独立测试数据用于验证布局、焦点和项目切换。', at: now - 9000 },
], ...extra });
const workspace = name => { const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'sample.txt'), 'File preview from isolated fixture.\n'); return { workspaceRoot: directory, displayName: name, boundAt: now }; };
const sessions = [fixture('legacy-chat', 'chat', '旧会话：一个很长的标题，用来检查列表省略、完整标题提示和旧历史显示。'.repeat(3), { pinned: true }), fixture('legacy-chat-two', 'chat', '另一个旧会话'), fixture('legacy-work', 'work', '旧 Work 会话', { workspaceBinding: workspace('workspace-work') }), fixture('project-a', 'code', '项目 A 的旧会话', { workspaceBinding: workspace('workspace-a') }), fixture('project-b', 'code', '项目 B 的旧会话', { workspaceBinding: workspace('workspace-b') })];
for (const session of sessions) fs.writeFileSync(path.join(sessionDir, session.id + '.json'), JSON.stringify(session));
fs.writeFileSync(path.join(sessionDir, '..', 'index.json'), JSON.stringify(sessions.map(({ messages, workspaceBinding, ...session }) => ({ ...session, messageCount: messages.length, ...(workspaceBinding ? { workspaceRoot: workspaceBinding.workspaceRoot, workspaceDisplayName: workspaceBinding.displayName } : {}) }))));

(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--firefly-profile=smoke', '--firefly-isolation-root=' + isolation], cwd: path.resolve(__dirname, '../..'), env, timeout: 30000 });
  try {
    await app.firstWindow();
    let page;
    for (let i = 0; i < 50; i++) { page = app.windows().find(window => /react\/index/.test(window.url())); if (page) break; await new Promise(resolve => setTimeout(resolve, 200)); }
    if (!page) throw new Error('No React chat window: ' + app.windows().map(window => window.url()).join(', '));
    const capture = async (targetPage, options) => { await targetPage.waitForTimeout(350); await targetPage.screenshot({ ...options, animations: 'disabled' }); };
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('.ff-page-rail');
    const resize = async (targetPage, width, height) => { const win = await app.browserWindow(targetPage); await win.evaluate((window, dimensions) => { window.setMinimumSize(320, 400); window.setSize(...dimensions); }, [width, height]); };
    await resize(page, 1280, 760);
    await page.evaluate(() => window.chatStore.openInReactChatWindow('legacy-chat'));
    await page.waitForSelector('[data-session-id="legacy-chat"]');
    await page.waitForSelector('.ff-message-list');
    await capture(page, { path: path.join(root, 'chat-wide.png') });
    await page.locator('textarea.ant-sender-input').fill('旧会话草稿，折叠后仍应保留');
    await page.getByRole('button', { name: '切换侧栏', exact: true }).click();
    if (await page.locator('textarea.ant-sender-input').inputValue() !== '旧会话草稿，折叠后仍应保留') throw new Error('Draft lost on collapse');
    await page.getByRole('button', { name: '设置', exact: true }).focus();
    if (!await page.getByRole('button', { name: '设置', exact: true }).evaluate(button => button === document.activeElement)) throw new Error('Settings focus lost');
    await capture(page, { path: path.join(root, 'chat-collapsed.png') });
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.waitForSelector('.ff-page-more');
    await capture(page, { path: path.join(root, 'chat-more.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    let settings;
    for (let i = 0; i < 40; i++) { settings = app.windows().find(window => /settings\/index/.test(window.url())); if (settings) break; await new Promise(resolve => setTimeout(resolve, 200)); }
    if (!settings) throw new Error('Settings window did not open');
    await settings.waitForSelector('.nav-item.is-active[data-section="general"]');
    await settings.locator('#toast-sound-enabled').uncheck();
    await settings.locator('#general-form button[type=submit]').click();
    await settings.waitForSelector('#general-save-status.is-ok');
    if ((await settings.evaluate(() => window.settings.getGeneral())).toastSoundEnabled !== false) throw new Error('General save not persisted');
    await capture(settings, { path: path.join(root, 'settings-general.png') });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('settings:save-general');
      ipcMain.handle('settings:save-general', () => { throw new Error('Isolated QA fault: settings save rejected'); });
    });
    await settings.locator('#general-form button[type=submit]').click();
    await settings.waitForSelector('#general-save-status.is-error');
    await capture(settings, { path: path.join(root, 'settings-save-error.png') });
    for (const section of ['preferences', 'appearance']) { await settings.locator(`[data-section="${section}"]`).click(); await capture(settings, { path: path.join(root, `settings-${section}.png`) }); }
    await resize(settings, 600, 720);
    await settings.locator('[data-section="general"]').click();
    await capture(settings, { path: path.join(root, 'settings-narrow.png') });
    await resize(page, 960, 540);
    await page.getByRole('button', { name: '切换侧栏', exact: true }).click();
    await page.waitForSelector('.ff-page-dock.is-compact');
    await page.evaluate(() => window.chatStore.openInReactChatWindow('project-a'));
    await page.getByRole('button', { name: '展开/收起右侧面板', exact: true }).click();
    await page.waitForSelector('.ff-right-inspector');
    await page.locator('textarea.ant-sender-input').fill('多行草稿\n'.repeat(10));
    await capture(page, { path: path.join(root, 'chat-inspector-short.png') });
    const geometry = await page.evaluate(() => {
      const composer = document.querySelector('.ff-composer-shell').getBoundingClientRect();
      const workspace = document.querySelector('.ff-workspace').getBoundingClientRect();
      const send = document.querySelector('.ant-sender-actions-btn').getBoundingClientRect();
      return { composer: composer.toJSON(), workspace: workspace.toJSON(), send: send.toJSON(), viewport: { width: innerWidth, height: innerHeight } };
    });
    fs.writeFileSync(path.join(root, 'geometry.json'), JSON.stringify(geometry, null, 2));
    if (geometry.composer.bottom > geometry.workspace.bottom + 1) throw new Error('Composer clipped below chat panel');
    if (!await page.locator('.ant-sender-actions-btn').evaluate(button => { const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x+r.width/2, r.y+r.height/2)); })) throw new Error('Send/stop action obstructed');
    await page.locator('.ff-code-git__dragbar').click();
    await page.locator('textarea.ant-sender-input').focus();
    await page.locator('.ff-composer__footer').scrollIntoViewIfNeeded();
    await capture(page, { path: path.join(root, 'chat-git-expanded.png') });
    await page.locator('.ff-code-git__dragbar').click();
    await page.locator('.ff-right-inspector__close').click();
    await page.waitForSelector('.ff-right-inspector', { state: 'detached' });
    await page.evaluate(() => window.chatStore.openInReactChatWindow('project-b'));
    await page.getByRole('button', { name: '展开/收起右侧面板', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-session-id="project-b"]')?.closest('.ant-conversations-item')?.className.includes('active'));
    await page.waitForSelector('.ff-file-tree');
    await page.locator('.ff-file-tree').getByText('sample.txt', { exact: true }).click();
    await page.waitForSelector('.ff-file-preview');
    await capture(page, { path: path.join(root, 'chat-file-preview.png') });
    await page.locator('.ff-right-inspector__close').click();
    await capture(page, { path: path.join(root, 'chat-project-b.png') });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('agui:run'); ipcMain.removeHandler('agui:cancel');
      globalThis.qaCancelCount = 0;
      ipcMain.handle('agui:run', (event, input) => {
        globalThis.qaRun = { sender: event.sender, input, runId: 'layout-fixture-run' };
        return { success: true, runId: 'layout-fixture-run' };
      });
      ipcMain.handle('agui:cancel', () => {
        globalThis.qaCancelCount++;

      });
    });
    await page.locator('textarea.ant-sender-input').fill('隔离的流式布局测试');
    await page.locator('.ant-sender-actions-btn').click();
    const stop = page.getByRole('button', { name: '停止运行', exact: true });
    await capture(page, { path: path.join(root, 'chat-before-streaming.png') });
    if (!await app.evaluate(() => Boolean(globalThis.qaRun))) throw new Error('Streaming fixture not accepted');
    await stop.waitFor();
    const chatWindow = await app.browserWindow(page);
    await chatWindow.evaluate(window => {
      window.webContents.send('agui:event', { type: 'RUN_STARTED', runId: 'layout-fixture-run', threadId: 'project-b' });
      window.webContents.send('agui:event', { type: 'TEXT_MESSAGE_START', messageId: 'layout-fixture-response', role: 'assistant', runId: 'layout-fixture-run' });
      window.webContents.send('agui:event', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'layout-fixture-response', delta: '隔离的流式 UI fixture：停止操作应始终可达。', runId: 'layout-fixture-run' });
    });
    await page.waitForTimeout(600);
    await capture(page, { path: path.join(root, 'chat-streaming-stop.png') });
    if (!await stop.evaluate(button => { const r = button.getBoundingClientRect(); return !button.disabled && button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })) throw new Error('Streaming stop obscured');
    await stop.click();
    if (await app.evaluate(() => globalThis.qaCancelCount) !== 1) throw new Error('Cancellation not delivered exactly once');
    await chatWindow.evaluate(window => window.webContents.send('agui:event', { type: 'RUN_FINISHED', runId: 'layout-fixture-run', threadId: 'project-b', result: { status: 'cancelled', reason: 'user_cancelled', externalEffectsMayContinue: false } }));
    await stop.waitFor({ state: 'detached' });
    if (await app.evaluate(() => globalThis.qaCancelCount) !== 1) throw new Error('Stop did not issue exactly one cancellation');
    await resize(page, 600, 720);
    await page.getByRole('button', { name: '切换侧栏', exact: true }).click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ff-page-sidebar')).opacity === '0');
    await capture(page, { path: path.join(root, 'chat-narrow.png') });
    await resize(page, 960, 540);
    await page.evaluate(() => window.chatStore.openInReactChatWindow('legacy-work'));
    await page.locator('.ff-todo__dragbar').click();
    await page.locator('textarea.ant-sender-input').fill('长 Work 草稿\n'.repeat(10));
    await page.locator('textarea.ant-sender-input').focus();
    await page.locator('.ff-composer__footer').scrollIntoViewIfNeeded();
    await capture(page, { path: path.join(root, 'chat-work-todo.png') });
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await capture(page, { path: path.join(root, 'chat-new-work.png') });
    const paths = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), appData: app.getPath('appData'), sessionData: app.getPath('sessionData') }));
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ paths, errors, screenshots: fs.readdirSync(root).filter(name => name.endsWith('.png')), checks: ['legacy history loaded', 'collapse preserves draft', 'settings keyboard focus', 'More menu', 'default general', 'preferences and appearance routing', '600px isolated narrow windows', 'General real save/readback', 'General injected IPC failure visible', 'last Inspector tab closes', 'project A to B', 'file preview', 'Git dock expanded keyboard focus', 'AGUI fixture streaming stop reachable and one cancel', 'Work Todo expansion and long draft keyboard focus', 'new Work conversation'] }, null, 2));
    console.log(JSON.stringify({ paths, errors, screenshots: fs.readdirSync(root).filter(name => name.endsWith('.png')) }));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
