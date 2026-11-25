import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpDrawing } from '../src/lib/mcp-drawing.js';

test('valid object points produce finite exportable coordinates and preserve requested style', () => {
  const input={points:[{x:100,y:300},{x:200,y:300}],thickness:3,opacity:0.5};
  const result=mcpDrawing(input,x=>x*2);
  assert.deepEqual(result.points[0],{x:200,y:600,pressure:0.5});
  assert.deepEqual(result.points.at(-1),{x:400,y:600,pressure:0.5});
  assert.equal(result.thickness,6);assert.equal(result.opacity,0.5);
  assert.ok(result.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
  assert.ok(!JSON.stringify(result).includes('null'));
  assert.deepEqual(input.points,[{x:100,y:300},{x:200,y:300}]);
});
for(const [label,points] of [
  ['the reported coordinate string','[100, 300], [200, 300]'],
  ['the reported flat number array',[100,300]],
  ['coordinate pair arrays',[[100,300],[200,300]]],
  ['missing coordinates',[{x:100},{x:200,y:300}]],
  ['null points',[null,{x:200,y:300}]],
  ['NaN',[{x:NaN,y:300},{x:200,y:300}]],
  ['infinity',[{x:100,y:Infinity},{x:200,y:300}]],
  ['numeric strings',[{x:'100',y:300},{x:200,y:300}]],
  ['one point',[{x:100,y:300}]],
])test(`rejects ${label} before a stroke can be created`,()=>assert.throws(()=>mcpDrawing({points}),/points|point/i));
test('rejects identical points and excessive interpolation rather than hanging or creating an invalid stroke',()=>{
  assert.throws(()=>mcpDrawing({points:[{x:10,y:10},{x:10,y:10}]}),/distinct/);
  assert.throws(()=>mcpDrawing({points:[{x:0,y:0},{x:1e100,y:0}]}),/too long/);
});
test('rejects invalid thickness and opacity',()=>{
  const points=[{x:1,y:2},{x:3,y:4}];
  for(const thickness of [null,'3',NaN,Infinity,0,-3,100])assert.throws(()=>mcpDrawing({points,thickness}),/thickness/);
  for(const opacity of [null,'0.5',NaN,Infinity,0,2])assert.throws(()=>mcpDrawing({points,opacity}),/opacity/);
});
