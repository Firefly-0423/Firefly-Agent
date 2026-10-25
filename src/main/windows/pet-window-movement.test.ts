import {describe,expect,it,vi} from "vitest";
import {PetWindowMoveController,type PetWindowLike} from "./pet-window-movement";

function fakeWindow(position:[number,number]=[100,200]){
 const setPosition=vi.fn();
 const window:PetWindowLike={isDestroyed:()=>false,getPosition:()=>[...position],setPosition};
 return{window,setPosition,position};
}

describe("PetWindowMoveController",()=>{
 it("moves relatively and rounds fractional deltas",()=>{
  const {window,setPosition}=fakeWindow([100,200]);
  const controller=new PetWindowMoveController(()=>window,vi.fn());
  controller.moveRelative(5.4,-3.6);
  expect(setPosition).toHaveBeenCalledWith(105,196,false);
 });
 it("clamps relative movement to the coordinate limit",()=>{
  const {window,setPosition}=fakeWindow([999_999,0]);
  const controller=new PetWindowMoveController(()=>window,vi.fn());
  controller.moveRelative(500,0);
  expect(setPosition).toHaveBeenCalledWith(1_000_000,0,false);
 });
 it("ignores non-numeric deltas before looking up the window",()=>{
  const getWindow=vi.fn(()=>null);
  const controller=new PetWindowMoveController(getWindow,vi.fn());
  controller.moveRelative("5",0);
  controller.moveRelative(Number.NaN,0);
  expect(getWindow).not.toHaveBeenCalled();
 });
 it("ignores missing and destroyed windows",()=>{
  const setPosition=vi.fn();
  const destroyed:PetWindowLike={isDestroyed:()=>true,getPosition:()=>[0,0],setPosition};
  const controller=new PetWindowMoveController(()=>destroyed,vi.fn());
  controller.moveRelative(1,1);
  expect(setPosition).not.toHaveBeenCalled();
  const missing=new PetWindowMoveController(()=>null,vi.fn());
  expect(()=>missing.queueAbsolute(10,20)).not.toThrow();
 });
 it("queues absolute positions and skips no-op moves",()=>{
  const {window,setPosition}=fakeWindow([10,20]);
  const controller=new PetWindowMoveController(()=>window,vi.fn());
  controller.queueAbsolute(10.2,19.7);
  expect(setPosition).not.toHaveBeenCalled();
  controller.queueAbsolute(30,40);
  expect(setPosition).toHaveBeenCalledWith(30,40,false);
 });
 it("rejects invalid absolute positions",()=>{
  const {window,setPosition}=fakeWindow();
  const controller=new PetWindowMoveController(()=>window,vi.fn());
  controller.queueAbsolute("10",20);
  controller.queueAbsolute(10,Infinity);
  expect(setPosition).not.toHaveBeenCalled();
 });
 it("persists the current position when dragging finishes",()=>{
  const {window}=fakeWindow([12.4,88.8]);
  const persist=vi.fn();
  const controller=new PetWindowMoveController(()=>window,persist);
  controller.finishDragging();
  expect(persist).toHaveBeenCalledWith({x:12,y:89});
 });
 it("logs and swallows position read failures",()=>{
  const log=vi.fn();
  const broken:PetWindowLike={isDestroyed:()=>false,getPosition:()=>{throw new Error("read failed")},setPosition:vi.fn()};
  const controller=new PetWindowMoveController(()=>broken,vi.fn(),log);
  controller.moveRelative(1,1);
  expect(log).toHaveBeenCalledWith("[Firefly] Failed to move pet window relatively:",expect.any(Error));
  controller.queueAbsolute(5,5);
  expect(log).toHaveBeenCalledWith("[Firefly] Failed to move pet window:",expect.any(Error));
  controller.finishDragging();
  expect(log).toHaveBeenCalledWith("[Firefly] Failed to persist the pet window position:",expect.any(Error));
 });
 it("does not persist when the window is destroyed",()=>{
  const persist=vi.fn();
  const window:PetWindowLike={isDestroyed:()=>true,getPosition:()=>[1,2],setPosition:vi.fn()};
  new PetWindowMoveController(()=>window,persist).finishDragging();
  expect(persist).not.toHaveBeenCalled();
 });
});
