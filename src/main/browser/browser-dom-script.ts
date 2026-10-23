import type { BrowserDomInput } from "../../shared/manual-browser";
import { ACCOUNT_ACTION_LABEL_SOURCE, ACCOUNT_PATH_SOURCE, SENSITIVE_FIELD_SOURCE } from "../../shared/browser-account-policy";
/** Fixed source in an isolated world. Only JSON data crosses this boundary;
 * callers cannot supply JavaScript, selectors, evaluation expressions or a CDP command.
 */
const operation = String.raw`(input => {
  const denied = () => ({ok:false});
  if (location.href !== input.url || location.protocol !== 'https:') return denied();
  const sensitive = new RegExp(${JSON.stringify(SENSITIVE_FIELD_SOURCE)}, 'i');
  const account = new RegExp(${JSON.stringify(ACCOUNT_PATH_SOURCE)}, 'i');
  const accountAction = new RegExp(${JSON.stringify(ACCOUNT_ACTION_LABEL_SOURCE)}, 'i');
  const safeUrl = value => {
    try { const u = new URL(value, location.href); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && !account.test(decodeURIComponent(u.pathname)) && (!input.hosts || input.hosts.includes(u.hostname)); }
    catch { return false; }
  };
  const visible = el => {
    if (!el.isConnected || el.closest('[hidden],[inert]')) return false;
    for (let node = el; node; node = node.parentElement) { const style = getComputedStyle(node); if (style.display === 'none' || style.visibility === 'hidden') return false; }
    return true;
  };
  const textInput = el => (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text','search','url'].includes(el.type)))
    && !el.disabled && !el.readOnly && !sensitive.test([el.name,el.id,el.autocomplete,el.getAttribute('aria-label'),el.getAttribute('placeholder')].join(' '))
    && !el.closest('form')?.querySelector('input[type=password],input[autocomplete=one-time-code],input[autocomplete^=cc-],input[type=file]');
  // Deliberately narrow: an explicit search form, one query field, and a
  // conventional search endpoint. GET alone does not make arbitrary forms safe.
  const searchSubmit = el => {
    const form = el.form;
    if (!form || !(form.getAttribute('role') === 'search' || form.closest('search'))
      || form.method.toLowerCase() !== 'get' || (form.target && form.target !== '_self')
      || ['formaction','formmethod','formtarget','formenctype'].some(name => el.hasAttribute(name))
      || el.name || !safeUrl(form.action) || !/^\/search\/?$/.test(new URL(form.action).pathname)) return false;
    const fields = Array.from(form.elements).filter(field => !field.disabled && field !== el
      && !(field.tagName === 'BUTTON' && !field.name));
    return fields.length === 1 && fields[0].tagName === 'INPUT' && fields[0].type === 'search'
      && ['q','query','search'].includes(fields[0].name) && textInput(fields[0]);
  };
  const clickable = el => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[download]') || accountAction.test(el.getAttribute('aria-label') || el.innerText || el.textContent || '')) return false;
    const a = el.closest('a[href]');
    if (a) return safeUrl(a.href) && !a.download && (!a.target || a.target === '_self');
    if (el.tagName === 'BUTTON' && el.type === 'submit' && el.form) return searchSubmit(el);
    if (el.tagName === 'INPUT') return false;
    return ['BUTTON','SUMMARY'].includes(el.tagName) || el.getAttribute('role') === 'button';
  };
  if (input.kind === 'observe') {
    const refs = new Map(), elements = [];
    for (const el of document.querySelectorAll('a[href],button,input,textarea,summary,[role=button]')) {
      if (elements.length >= 160) break;
      if (!visible(el) || !(textInput(el) || clickable(el))) continue;
      const ref = String(elements.length + 1); refs.set(ref, el);
      const name = (el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('placeholder') || el.name || '').trim().slice(0,200);
      elements.push({ref,tag:el.tagName.toLowerCase(),role:el.getAttribute('role') || (textInput(el)?'textbox':el.tagName==='A'?'link':'button'),name,
        ...(textInput(el)?{value:el.value.slice(0,1000)}:{}), ...(el.tagName==='A'?{href:el.href.slice(0,2048)}:{})});
    }
    globalThis.__fireflyBrowserDom = {snapshotId:input.snapshotId,document,refs};
    const body = document.body;
    let text = body?.innerText;
    if (text === undefined && body) { const copy = body.cloneNode(true); for(const hidden of copy.querySelectorAll('script,style,noscript,template,[hidden]')) hidden.remove(); text=copy.textContent; }
    return {snapshotId:input.snapshotId,url:location.href,title:document.title.slice(0,500),text:(text || '').slice(0,20000),elements};
  }
  const state = globalThis.__fireflyBrowserDom;
  if (!state || state.document !== document || state.snapshotId !== input.snapshotId) return denied();
  const el = state.refs.get(input.ref);
  if (!el || !visible(el)) return denied();
  if (input.kind === 'click' && clickable(el)) { el.click(); return {ok:true}; }
  if (input.kind === 'type' && textInput(el) && typeof input.text === 'string' && input.text.length <= 4000) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el,input.text);
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true};
  }
  return denied();
})`;
export function browserDomScript(input: BrowserDomInput): string { return `${operation}(${JSON.stringify(input)})`; }
