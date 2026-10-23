// Isolated, offline UI acceptance. Existing main/preload are read only; renderer output is supplied.
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const repo = path.resolve(__dirname, '../..');
const root = path.resolve(process.argv[2]);
const bootstrap = path.join(root, 'qa-main.cjs');
if (!fs.existsSync(bootstrap)) throw new Error('Explicit isolated QA bootstrap required');
const isolation = path.join(root, 'profile-' + Date.now());
fs.mkdirSync(isolation, { recursive: true });
(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: [bootstrap, '--firefly-profile=smoke', '--firefly-isolation-root=' + isolation], cwd: repo, env, timeout: 45000 });
  const evidence = { screenshots: [], cases: [], errors: [], offline: true, profile: isolation };
  try {
    await app.firstWindow();
    let page;
    for (let i = 0; i < 100; i++) {
      page = app.windows().find(p => /react\/index/.test(p.url()));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!page) throw new Error('Chat window not found');
    evidence.pid = app.process().pid;
    page.on('pageerror', error => evidence.errors.push(error.message));
    await page.waitForSelector('.ff-inspector-toggle-float');
    const win = await app.browserWindow(page);
    const resize = async (width, height = 760) => {
      await win.evaluate((window, dimensions) => window.setSize(...dimensions), [width, height]);
      await page.waitForTimeout(450);
    };
    const capture = async name => {
      await page.screenshot({ path: path.join(root, name + '.png'), animations: 'disabled' });
      evidence.screenshots.push(name + '.png');
    };
    // Read the product's actual labels from source for deterministic locale matching.
    const t = JSON.parse(fs.readFileSync(path.join(repo, 'src/renderer/react/i18n/zh-CN.json'), 'utf8'));
    const mode = async name => {
      await page.locator('.ff-mode-picker__trigger').click();
      await page.getByRole('menuitemradio').filter({ hasText: new RegExp('^' + name) }).click();
      await page.waitForTimeout(250);
    };
    const open = async label => {
      await page.locator('.ff-inspector-toggle-float').getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(300);
    };
    const assertGeometry = async () => {
      const geometry = await page.evaluate(() => {
        const rect = selector => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
        return { width: innerWidth, chat: rect('.ff-workspace'), right: rect('.ff-right-inspector'), left: rect('.ff-page-sidebar'), compact: !!document.querySelector('.ff-page-dock.is-compact'), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      if (geometry.compact || geometry.overflow || geometry.chat.width < 299 || geometry.right.width < 279 || geometry.right.right > geometry.width + 1 || geometry.right.x < geometry.chat.right - 1 || Math.abs(geometry.right.y - geometry.chat.y) > 1) throw new Error('Horizontal geometry failed: ' + JSON.stringify(geometry));
      evidence.cases.push({ type: 'geometry', ...geometry });
    };
    await resize(1280);
    await mode('Chat');
    const input = page.locator('textarea.ant-sender-input');
    await input.fill('Synthetic draft survives layout changes.');
    for (const name of ['Chat', 'Work', 'Code']) {
      if (name !== 'Chat') await mode(name);
      if (name !== 'Chat') {
        await open(t.workspace.tasks);
        if (await page.locator('.ff-workspace .ff-todo, .ff-workspace .ff-code-git').count()) throw new Error('Task card leaked into chat');
        if (name === 'Work') {
          const body = await page.locator('.ff-todo__body').evaluate(node => ({ maxHeight: getComputedStyle(node).maxHeight, height: node.getBoundingClientRect().height }));
          if (body.maxHeight !== 'none') throw new Error('Task body retained top-strip height limit: ' + JSON.stringify(body));
        }
        await capture(name.toLowerCase() + '-welcome-tasks');
        await page.locator('.ff-page-rail').getByRole('button', { name: t.ui.plugins, exact: true }).click();
        if (await page.locator('.ff-right-inspector').count()) throw new Error('Task inspector squeezed standalone plugin panel');
        await page.getByRole('button', { name: t.ui.workbench, exact: true }).click();
        await page.waitForSelector('.ff-right-inspector');
        evidence.cases.push({ type: 'standalone-panel', mode: name, inspectorHidden: true, conversationRestored: true });
      }
      await open(t.browserWorkspace.open);
      await page.waitForSelector('.ff-browser-workspace');
      if (await page.locator('iframe,webview').count()) throw new Error('Unexpected browser guest');
      await page.getByRole('alert').filter({ hasText: t.browserWorkspace.unavailable }).waitFor();
      await assertGeometry();
      await capture(name.toLowerCase() + '-welcome-browser');
      await open(t.fileTree.title);
      await page.locator('.ff-workspace-empty:visible').waitFor();
      if (name !== 'Chat' && !await page.locator('.ff-workspace-empty:visible [data-workspace-choose]').isVisible()) throw new Error('Missing workspace chooser');
      await resize(960, 540);
      await assertGeometry();
      await capture(name.toLowerCase() + '-minimum-files');
      await resize(1280);
      evidence.cases.push({ type: 'welcome', mode: name, entries: true });
    }
    await mode('Chat');
    if (await input.inputValue() !== 'Synthetic draft survives layout changes.') throw new Error('Chat draft lost during mode changes');
    await open(t.browserWorkspace.open);
    const browserInput = page.locator('.ff-browser-workspace input');
    await browserInput.fill('https://example.invalid/synthetic-draft');
    await open(t.rightInspector.toggle);
    if (await page.locator('.ff-right-inspector').count()) throw new Error('Inspector hide failed');
    await open(t.rightInspector.toggle);
    await page.waitForSelector('.ff-right-inspector');
    // Content remounts on hide; tabs and the chat draft stay intact.
    if (await input.inputValue() !== 'Synthetic draft survives layout changes.') throw new Error('Draft lost on inspector toggle');
    const drag = async (selector, dx) => {
      const box = await page.locator(selector).boundingBox();
      if (!box) throw new Error('Missing resize handle: ' + selector);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
      await page.waitForTimeout(200);
    };
    await drag('.ff-sidebar-resizer', 85);
    const saved = await page.locator('.ff-page-sidebar').evaluate(node => node.getBoundingClientRect().width);
    await page.getByRole('button', { name: t.ui.toggleSidebar, exact: true }).click();
    if (await page.locator('.ff-sidebar-resizer').count()) throw new Error('Hidden sidebar retained resize handle');
    await page.getByRole('button', { name: t.ui.toggleSidebar, exact: true }).click();
    const restored = await page.locator('.ff-page-sidebar').evaluate(node => node.getBoundingClientRect().width);
    if (Math.abs(restored - saved) > 1) throw new Error('Sidebar width not restored');
    await drag('.ff-dock-separator', -60);
    await assertGeometry();
    await capture('chat-resized');
    await resize(960, 540); await assertGeometry();
    await resize(1600, 900); await assertGeometry(); await capture('chat-wide');
    const avatar = await page.locator('.ff-rail-user .is-placeholder').evaluate(node => {
      const style = getComputedStyle(node), text = getComputedStyle(node.querySelector('span'));
      return { background: style.backgroundColor, color: text.color, radius: style.borderRadius, text: node.textContent };
    });
    if (avatar.background !== 'rgb(255, 255, 255)' || avatar.color !== 'rgb(63, 63, 63)' || avatar.radius !== '50%' || avatar.text !== 'U') throw new Error('Placeholder style failed: ' + JSON.stringify(avatar));
    evidence.cases.push({ type: 'avatar', ...avatar });
    const radii = await page.evaluate(() => Object.fromEntries(['.ff-workspace', '.ff-right-inspector', '.ant-sender'].map(s => [s, getComputedStyle(document.querySelector(s)).borderTopLeftRadius])));
    if (Object.values(radii).some(radius => radius !== '12px')) throw new Error('Container radius failed: ' + JSON.stringify(radii));
    evidence.cases.push({ type: 'radius', radii });
    const before = await page.evaluate(() => window.chatStore.list());
    if (before.length) throw new Error('Welcome interactions created a session');
    // Create real synthetic sessions through the existing isolated-profile store only.
    const workspace = path.join(root, 'fixture-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'sample.txt'), 'Synthetic workspace file preview.');
    const sessionIds = await page.evaluate(async workspace => {
      const ids = {};
      for (const mode of ['chat', 'work', 'code']) {
        const s = await window.chatStore.create({ identityId: null, mode, title: 'Synthetic ' + mode });
        await window.chatStore.append(s.id, { id: 'synthetic-user-' + mode, role: 'user', content: 'Synthetic existing conversation.', at: Date.now() });
        if (mode !== 'chat') {
          const result = await window.chatStore.setWorkspace(s.id, workspace);
          if (!result.ok) throw new Error('Synthetic workspace binding failed');
        }
        ids[mode] = s.id;
      }
      return ids;
    }, workspace);
    for (const [name, id] of Object.entries(sessionIds)) {
      await page.evaluate(id => window.chatStore.openInReactChatWindow(id), id);
      await page.waitForTimeout(400);
      await open(t.browserWorkspace.open); await assertGeometry();
      await open(t.fileTree.title);
      if (name === 'chat') await page.locator('.ff-workspace-empty:visible').waitFor();
      else {
        await page.getByText('sample.txt', { exact: true }).click();
        await page.getByText('Synthetic workspace file preview.', { exact: true }).waitFor();
        evidence.cases.push({ type: 'file-preview', mode: name, owner: id });
      }
      await capture(name + '-existing-session');
      evidence.cases.push({ type: 'existing-session', mode: name });
    }
    // Close the active file preview first; the pinned tree can then close after browser.
    await page.locator('.ff-right-inspector__close').click();
    // Close browser, then files; repeated opening does not duplicate tabs.
    for (let i = 0; i < 3; i++) {
      await open(t.browserWorkspace.open);
      await page.getByRole('button', { name: t.browserWorkspace.close, exact: true }).click();
      await open(t.fileTree.title);
      await page.locator('.ff-right-inspector__close').click();
    }
    if (evidence.errors.length) throw new Error('Renderer errors: ' + evidence.errors.join('; '));
    evidence.ok = true;
  } catch (error) { evidence.ok = false; evidence.failure = String(error.stack || error); throw error; }
  finally {
    fs.writeFileSync(path.join(root, 'pixel-qa.json'), JSON.stringify(evidence, null, 2));
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
