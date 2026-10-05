// Self-check of the save-state copy (web/src/host/savestate.js) on a small stand-in for the
// recompiled game's objects: class instances and arrays marked with Symbol("teavm_meta"),
// pointing at each other and at host objects that can be disposed.
//
//   node tools/states/verify.mjs
import assert from 'node:assert/strict';
import { SaveStates } from '../../web/src/host/savestate.js';

const meta = Symbol('teavm_meta');
class JavaObject {}
JavaObject[meta] = {};
class Player extends JavaObject {
  constructor() {
    super();
    this.$life = 10;
    this.$name = 'rock';
    this.$pos = null;
    this.$model = null;
    this.$next = null;
  }
}
Player[meta] = {};
class JavaArray extends JavaObject {
  constructor(data) {
    super();
    this.data = data;
  }
}
JavaArray[meta] = {};

class HostThing {
  disposed = false;
  dispose() {
    this.disposed = true;
  }
}

const events = [];
const part = { value: 1, snapshot() { return this.value; }, restore(v) { this.value = v; } };
const states = new SaveStates({ list: [part], afterLoad: () => events.push('after'), notify: (kind) => events.push(kind) });

const model = new HostThing();
const player = new Player();
player.$pos = new JavaArray(new Float32Array([1, 2, 3]));
player.$model = model;
const other = new Player();
other.$next = player; // a cycle
player.$next = other;
const list = new JavaArray([player, other, null]);
const roots = new JavaArray([list, 7]);

// nothing saved yet
states.requestLoad();
assert.equal(events.pop(), 'empty');
assert.equal(states.takeRequest(), 0);

// refused when the game says it is not a moment to save
assert.equal(states.save(null, false), false);
assert.equal(events.pop(), 'refused');
assert.equal(states.available, false);

states.requestSave();
assert.equal(states.takeRequest(), 1);
assert.equal(states.takeRequest(), 0);
assert.equal(states.save(roots, true), true);
assert.equal(events.pop(), 'saved');
assert.equal(states.stats.objects, 5); // roots, list, two players, the position array
assert.equal(states.stats.hosts, 1);

// the game moves on: fields, array contents, array length, references, new objects
player.$life = 3;
player.$name = 'dead';
player.$pos.data[1] = 99;
const replacement = new JavaArray(new Float32Array([7, 7, 7]));
other.$pos = replacement;
const third = new Player();
list.data.push(third);
list.data[0] = third;
roots.data[1] = 8;
part.value = 2;
const later = new HostThing(); // made after the save
third.$model = later;

// disposal: what the state refers to is set aside, anything else is freed at once
states.dispose(model);
states.dispose(later);
assert.equal(model.disposed, false);
assert.equal(later.disposed, true);
player.$model = null;

states.requestLoad();
assert.equal(states.takeRequest(), 2);
assert.equal(states.load(), true);
assert.deepEqual(events.splice(-2), ['after', 'loaded']);
assert.equal(player.$life, 10);
assert.equal(player.$name, 'rock');
assert.deepEqual([...player.$pos.data], [1, 2, 3]);
assert.equal(other.$pos, null);
assert.deepEqual(list.data, [player, other, null]);
assert.equal(roots.data[1], 7);
assert.equal(player.$model, model);
assert.equal(model.disposed, false);
assert.equal(part.value, 1);

// loading put the model back in use: a new save must not free it
assert.equal(states.save(roots, true), true);
assert.equal(model.disposed, false);

// disposed after this save, then a newer save: now it is really freed
states.dispose(model);
player.$model = null;
assert.equal(model.disposed, false);
assert.equal(states.save(roots, true), true);
assert.equal(model.disposed, true);
assert.equal(states.stats.hosts, 0);

console.log('save states: ok');
