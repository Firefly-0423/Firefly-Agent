import {describe,expect,it} from 'vitest';
import {toWindows} from './history-windows';
const m=(...texts:string[])=>texts.map(text=>({text}));
describe('toWindows',()=>{
 it('splits consecutive messages into non-overlapping windows',()=>{
  expect(toWindows(m('a','b','c','d','e'),2)).toEqual([{text:'a\nb'},{text:'c\nd'},{text:'e'}]);
  expect(toWindows(m('a','b','c'),1)).toEqual([{text:'a'},{text:'b'},{text:'c'}]);
 });
 it('does not split a conversation that already fits one window, or when disabled',()=>{
  expect(toWindows(m('a','b'),2)).toBeNull();expect(toWindows(m('a'),2)).toBeNull();expect(toWindows([],2)).toBeNull();
  expect(toWindows(m('a','b','c','d'),0)).toBeNull();expect(toWindows(m('a','b','c','d'),-1)).toBeNull();
 });
 it('rejects a non-integer window size instead of guessing',()=>{
  expect(toWindows(m('a','b','c','d'),1.5)).toBeNull();expect(toWindows(m('a','b','c','d'),NaN)).toBeNull();
 });
});
