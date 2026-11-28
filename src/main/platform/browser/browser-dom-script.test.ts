import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { browserDomScript } from "./browser-dom-script";
function page() {
  const dom = new JSDOM('<title>Public fixture</title><main><h1>Example</h1><a href="/next">Next page</a><button type="button" id="count">Count</button><input type="search" aria-label="Search"><input type="password" value="secret"><input name="token" value="secret"><a href="/login">Sign in</a></main>', { url: "https://example.com/", runScripts: "dangerously", pretendToBeVisual: true });
  let clicks = 0; dom.window.document.querySelector('#count')!.addEventListener('click', () => clicks++);
  const run = (input: any) => dom.window.eval(browserDomScript(input));
  return { dom, run, clicks: () => clicks };
}
describe("fixed isolated-world DOM operations", () => {
  it("observes bounded real DOM and click/type use only refs from that exact snapshot", () => {
    const f = page(), snapshot = f.run({ kind: "observe", snapshotId: "one", url: "https://example.com/" });
    expect(snapshot).toMatchObject({ snapshotId: "one", title: "Public fixture", url: "https://example.com/" });
    expect(snapshot.text).toContain("Example");
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    const button = snapshot.elements.find((e: any) => e.name === "Count"), input = snapshot.elements.find((e: any) => e.name === "Search");
    expect(f.run({ kind: "click", snapshotId: "one", ref: button.ref, url: snapshot.url })).toEqual({ ok: true }); expect(f.clicks()).toBe(1);
    expect(f.run({ kind: "type", snapshotId: "one", ref: input.ref, text: 'hello ");window.evil=true;//', url: snapshot.url })).toEqual({ ok: true });
    expect((f.dom.window.document.querySelector('input[type=search]') as HTMLInputElement).value).toBe('hello ");window.evil=true;//');
    expect((f.dom.window as any).evil).toBeUndefined(); f.dom.window.close();
  });
  it("rejects old document/snapshot refs, credential fields and authentication links", () => {
    const f = page(), old = f.run({ kind: "observe", snapshotId: "one", url: "https://example.com/" });
    expect(old.elements.some((e: any) => e.name === "Sign in")).toBe(false);
    expect(old.elements.filter((e: any) => e.tag === "input")).toHaveLength(1);
    const button = old.elements.find((e: any) => e.name === "Count");
    f.run({ kind: "observe", snapshotId: "two", url: old.url });
    expect(f.run({ kind: "click", snapshotId: "one", ref: button.ref, url: old.url })).toEqual({ ok: false });
    expect(f.run({ kind: "click", snapshotId: "two", ref: "unknown", url: old.url })).toEqual({ ok: false });
    expect(f.run({ kind: "click", snapshotId: "two", ref: button.ref, url: "https://github.com/" })).toEqual({ ok: false });
    expect(f.clicks()).toBe(0); f.dom.window.close();
  });
  it("revalidates element mutations before a side effect and never submits forms or downloads", () => {
    const f = page(), snapshot = f.run({ kind: "observe", snapshotId: "one", url: "https://example.com/" });
    const input = snapshot.elements.find((e: any) => e.name === "Search");
    f.dom.window.document.querySelector('input[type=search]')!.setAttribute("type", "password");
    expect(f.run({ kind: "type", snapshotId: "one", ref: input.ref, text: "secret", url: snapshot.url })).toEqual({ ok: false });
    const link = snapshot.elements.find((e: any) => e.name === "Next page");
    f.dom.window.document.querySelector('a')!.setAttribute("href", "https://evil.example/");
    expect(f.run({ kind: "click", snapshotId: "one", ref: link.ref, url: snapshot.url, hosts: ["example.com"] })).toEqual({ ok: false });
    f.dom.window.close();
  });
});

it("excludes login controls, disabled form submissions and fields hidden by ancestors", () => {
  const f = page();
  f.dom.window.document.body.insertAdjacentHTML("beforeend", '<button type="button">Sign in</button><form><button>Submit</button></form><div style="display:none"><input aria-label="Hidden" value="hidden secret"></div><a href="/download" download>Download</a>');
  const snapshot = f.run({ kind: "observe", snapshotId: "one", url: "https://example.com/" });
  expect(snapshot.elements.some((e: any) => ["Sign in", "Submit", "Hidden", "Download"].includes(e.name))).toBe(false);
  expect(JSON.stringify(snapshot.elements)).not.toContain("hidden secret"); f.dom.window.close();
});

it("excludes payment, identity and sign-up controls from observation and from typing or clicking", () => {
  const f = page();
  f.dom.window.document.body.insertAdjacentHTML("beforeend",
    '<input name="cc-number" aria-label="Number"><input aria-label="CVV"><input placeholder="IBAN"><input autocomplete="cc-exp">'
    + '<a href="/join">Join now</a><a href="/login.php">Member area</a><button type="button">Buy now</button><button type="button">Pay</button><button type="button">Place order</button>'
    + '<form id="card"><input type="search" aria-label="Notes"><input autocomplete="cc-number"></form>');
  const snapshot = f.run({ kind: "observe", snapshotId: "one", url: "https://example.com/" });
  const names = snapshot.elements.map((e: any) => e.name);
  for (const blocked of ["Number", "CVV", "IBAN", "Join now", "Member area", "Buy now", "Pay", "Place order", "Notes"]) expect(names).not.toContain(blocked);
  expect(names).toContain("Count");
  f.dom.window.close();
});

it("submits an explicitly marked GET search with multilingual text and re-observes dynamic results", async () => {
  const f = page();
  f.dom.window.document.body.innerHTML = '<form role="search" action="/search" method="get"><input type="search" name="q" aria-label="Query"><button type="submit">Search</button></form><output></output>';
  let submitted = 0;
  f.dom.window.document.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault(); submitted++;
    f.dom.window.setTimeout(() => { f.dom.window.document.querySelector('output')!.textContent = 'Results: ' + (f.dom.window.document.querySelector('input') as HTMLInputElement).value; }, 0);
  });
  const observe = (snapshotId: string) => f.run({ kind: 'observe', snapshotId, url: 'https://example.com/', hosts: ['example.com'] });
  const first = observe('first');
  const input = first.elements.find((e: any) => e.name === 'Query');
  expect(f.run({kind:'type', snapshotId:'first', ref:input.ref, url:first.url, text:'Firefly 流萤', hosts:['example.com']})).toEqual({ok:true});
  const second = observe('second');
  const submit = second.elements.find((e: any) => e.name === 'Search');
  expect(submit).toBeDefined();
  expect(f.run({kind:'click', snapshotId:'second', ref:submit.ref, url:second.url, hosts:['example.com']})).toEqual({ok:true});
  await new Promise(resolve => f.dom.window.setTimeout(resolve, 5));
  expect(submitted).toBe(1); expect(observe('third').text).toContain('Results: Firefly 流萤');
  f.dom.window.close();
});

it.each([
  'method="post"', 'action="/delete"', 'action="https://other.example/search"', 'target="_blank"',
])("denies search submissions with unsafe form settings: %s", attributes => {
  const f = page();
  f.dom.window.document.body.innerHTML = `<form role="search" ${attributes}><input type="search" name="q"><button>Search</button></form>`;
  const snapshot = f.run({kind:'observe', snapshotId:'one', url:'https://example.com/', hosts:['example.com']});
  expect(snapshot.elements.some((e: any) => e.name === 'Search')).toBe(false); f.dom.window.close();
});

it.each(['<input type="hidden" name="delete" value="1">','<input type="password">','<input name="email">'])('denies search forms with additional or sensitive fields: %s', extra => {
  const f = page();
  f.dom.window.document.body.innerHTML = `<form role="search" action="/search"><input type="search" name="q">${extra}<button>Search</button></form>`;
  const snapshot = f.run({kind:'observe', snapshotId:'one', url:'https://example.com/', hosts:['example.com']});
  expect(snapshot.elements.some((e: any) => e.name === 'Search')).toBe(false); f.dom.window.close();
});

it.each(['post','action','hidden','override','sensitive'])("revalidates observed search forms before click: %s", mutation => {
  const f = page();
  f.dom.window.document.body.innerHTML = '<form role="search" action="/search"><input type="search" name="q"><button>Search</button></form>';
  const snapshot = f.run({kind:'observe',snapshotId:'one',url:'https://example.com/',hosts:['example.com']});
  const submit = snapshot.elements.find((e:any) => e.name === 'Search'); expect(submit).toBeDefined();
  const form = f.dom.window.document.querySelector('form')!, button = f.dom.window.document.querySelector('button')!;
  if(mutation === 'post') form.method = 'post';
  if(mutation === 'action') form.action = 'https://outside.example/search';
  if(mutation === 'hidden') form.insertAdjacentHTML('beforeend','<input type="hidden" name="delete" value="1">');
  if(mutation === 'override') button.setAttribute('formaction','/delete');
  if(mutation === 'sensitive') f.dom.window.document.querySelector('input')!.type = 'password';
  let submitted = false; form.addEventListener('submit', event => { event.preventDefault(); submitted = true; });
  expect(f.run({kind:'click',snapshotId:'one',url:snapshot.url,ref:submit.ref,hosts:['example.com']})).toEqual({ok:false});
  expect(submitted).toBe(false); f.dom.window.close();
});
