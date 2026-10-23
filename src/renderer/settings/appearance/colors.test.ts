// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { bindUiColorControls } from "./colors";
function fixture() {
 document.body.innerHTML = `<fieldset id="ui-color-controls"><input type="checkbox" id="ui-colors-enabled">${['accent','background','foreground'].map(k=>`<input type="color" id="ui-color-${k}"><input id="ui-color-${k}-hex">`).join('')}<button id="ui-colors-reset" type="button">Reset</button><p id="ui-colors-status"></p></fieldset>`;
 return document.body;
}
it("persists user edits, rejects invalid hex, and resets defaults", async () => {
 const root=fixture(),save=vi.fn(async()=>{}); const controls=bindUiColorControls(root,save); controls.load({ enabled: true, accent:'#123456' });
 const hex=root.querySelector<HTMLInputElement>('#ui-color-accent-hex')!;
 hex.value='#aabbcc';hex.dispatchEvent(new Event('change')); await controls.settled();
 expect(save).toHaveBeenLastCalledWith(expect.objectContaining({enabled:true,accent:'#aabbcc'}));
 hex.value='url(bad)';hex.dispatchEvent(new Event('change'));await controls.settled();expect(save).toHaveBeenCalledTimes(1);expect(hex.getAttribute('aria-invalid')).toBe('true');
 root.querySelector<HTMLButtonElement>('#ui-colors-reset')!.click();await controls.settled();expect(save).toHaveBeenLastCalledWith(expect.objectContaining({enabled:true,accent:'#0285ff'})); controls.dispose();
});
it("mirrors the swatch picker into its hex pill and saves the picked value on change", async()=>{
 const root=fixture();const save=vi.fn(async()=>{});const controls=bindUiColorControls(root,save);controls.load({enabled:true,accent:'#123456'});
 const picker=root.querySelector<HTMLInputElement>('#ui-color-accent')!;const hex=root.querySelector<HTMLInputElement>('#ui-color-accent-hex')!;
 picker.value='#abcdef';picker.dispatchEvent(new Event('input'));expect(hex.value).toBe('#abcdef');expect(save).not.toHaveBeenCalled();
 picker.dispatchEvent(new Event('change'));await controls.settled();
 expect(save).toHaveBeenLastCalledWith(expect.objectContaining({enabled:true,accent:'#abcdef'}));controls.dispose();
});
it("serializes rapid edits and shows save failure instead of claiming success", async()=>{
 const root=fixture();let release!:()=>void;
 const save=vi.fn().mockImplementationOnce(()=>new Promise<void>(r=>{release=r})).mockRejectedValueOnce(new Error('disk full'));
 const controls=bindUiColorControls(root,save);controls.load({enabled:true});
 const hex=root.querySelector<HTMLInputElement>('#ui-color-accent-hex')!;
 hex.value='#111111';hex.dispatchEvent(new Event('change'));await Promise.resolve();
 hex.value='#222222';hex.dispatchEvent(new Event('change'));expect(save).toHaveBeenCalledTimes(1);release();await controls.settled();
 expect(save).toHaveBeenCalledTimes(2);expect(root.querySelector('#ui-colors-status')!.textContent).toContain('失败');controls.dispose();
});
it("edits the dark theme's own set under the dark theme and leaves the light set alone", async()=>{
 document.documentElement.dataset.uiTheme='firefly-dark';
 const root=fixture();const save=vi.fn(async()=>{});const controls=bindUiColorControls(root,save);controls.load({enabled:true,accent:'#123456'});
 const hex=root.querySelector<HTMLInputElement>('#ui-color-background-hex')!;
 expect(hex.value).toBe('#192a24');
 hex.value='#101010';hex.dispatchEvent(new Event('change'));await controls.settled();
 expect(save).toHaveBeenLastCalledWith(expect.objectContaining({accent:'#123456',background:'#ffffff',dark:expect.objectContaining({background:'#101010'})}));
 root.querySelector<HTMLButtonElement>('#ui-colors-reset')!.click();await controls.settled();
 expect(save).toHaveBeenLastCalledWith(expect.objectContaining({accent:'#123456',dark:{accent:'#7bd8ae',background:'#192a24',foreground:'#e4eee9'}}));
 controls.dispose();delete document.documentElement.dataset.uiTheme;
});
