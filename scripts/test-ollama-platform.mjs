import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localQwenPlatform,runtimePlan,accelerationFromModels,OLLAMA_ASSETS} from '../src/lib/server/ollama-platform.js';
import {gpuVendor} from '../src/lib/server/ollama-hardware.js';
test('only supported native executable architectures are offered',()=>{
  for(const [platform,arch] of [['darwin','arm64'],['win32','x64'],['linux','x64']])assert.equal(localQwenPlatform(platform,arch),true);
  for(const [platform,arch] of [['darwin','x64'],['win32','arm64'],['linux','arm'],['freebsd','x64']])assert.equal(localQwenPlatform(platform,arch),false);
});
test('Intel/AMD x64 CPUs share the executable; GPU vendors choose extra runtime libraries',()=>{
  for(const platform of ['win32','linux']){
    const nvidia=runtimePlan(platform,'x64',['intel','nvidia']);
    assert.equal(nvidia.packages.length,1);
    assert.ok(!nvidia.packages[0].name.includes('rocm'));
    assert.equal(runtimePlan(platform,'x64',['intel']).packages.length,1);
    const amd=runtimePlan(platform,'x64',['amd']);assert.equal(amd.packages.length,2);assert.match(amd.packages[1].name,/rocm/);
    assert.equal(runtimePlan(platform,'x64',['amd','nvidia']).packages.length,1);
  }
});
test('runtime assets are exact pinned release downloads with full SHA-256 values',()=>{
  for(const asset of Object.values(OLLAMA_ASSETS)){assert.match(asset.sha256,/^[a-f0-9]{64}$/);assert.ok(asset.size>0);}
  for(const asset of runtimePlan('linux','x64',['amd']).packages)assert.match(asset.url,/^https:\/\/github.com\/ollama\/ollama\/releases\/download\/v0\.40\.13\//);
  assert.equal(runtimePlan('darwin','arm64'),null);
  assert.equal(runtimePlan('win32','arm64'),null);
});
test('GPU adapters are identified by PCI vendor IDs, including Windows basic display drivers',()=>{
  assert.equal(gpuVendor('Microsoft Basic Display Adapter PCI\\VEN_10DE&DEV_1234'),'nvidia');
  assert.equal(gpuVendor('PCI\\VEN_1002&DEV_1234'),'amd');assert.equal(gpuVendor('0x8086\n'),'intel');assert.equal(gpuVendor('unknown'),null);
});
const model=(size,size_vram)=>[{name:'qwen3.5:4b-q4_K_M',size,size_vram}];
test('actual loaded-model placement distinguishes GPU, CPU, mixed and unknown',()=>{
  assert.equal(accelerationFromModels(model(100,100)).mode,'gpu');
  assert.equal(accelerationFromModels(model(100,50)).mode,'mixed');
  assert.equal(accelerationFromModels(model(100,50)).percent,50);
  assert.match(accelerationFromModels(model(100,0)).label,/CPU only/);
  assert.equal(accelerationFromModels(model(100,undefined)).mode,'unknown');
  assert.equal(accelerationFromModels([]),null);
  assert.equal(accelerationFromModels([{name:'other',size:100,size_vram:100}]),null);
});
