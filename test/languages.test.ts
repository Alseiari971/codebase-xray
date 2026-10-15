import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadParsers } from '../src/adapters/index.ts';
import { openDatabase, type XrayDb } from '../src/db/database.ts';
import { mainPath } from '../src/graph/overview.ts';
import { indexRepository } from '../src/indexer/indexer.ts';
import { makeRepo } from './helpers.ts';

const CPP_APP = join(import.meta.dirname, 'fixtures', 'cpp-app');
const PYTHON_APP = join(import.meta.dirname, 'fixtures', 'python-app');

// The Tree-sitter parsers are WebAssembly and load asynchronously.
await loadParsers();

function indexed(root: string): XrayDb {
  const db = openDatabase(':memory:');
  indexRepository(db, root);
  return db;
}

function rows<T>(db: XrayDb, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** One line per symbol: id, type and line range. */
function symbolList(db: XrayDb): string[] {
  return rows<{ id: string; type: string; start_line: number; end_line: number }>(
    db,
    "SELECT id, type, start_line, end_line FROM nodes WHERE layer = 'symbol' ORDER BY id",
  ).map((node) => `${node.id} ${node.type} ${node.start_line}-${node.end_line}`);
}

/** One line per edge, so a whole graph can be compared at once. */
function edgeList(db: XrayDb, relation: string): string[] {
  return rows<{ source: string; target: string; resolution_type: string; confidence: number }>(
    db,
    'SELECT source, target, resolution_type, confidence FROM edges WHERE relation = ? ORDER BY source, target',
    relation,
  ).map((edge) => `${edge.source} -> ${edge.target} [${edge.resolution_type} ${edge.confidence}]`);
}

function unresolved(db: XrayDb): Record<string, string[]> {
  return Object.fromEntries(
    rows<{ path: string; list: string }>(
      db,
      "SELECT path, json_extract(metadata, '$.unresolvedImports') AS list FROM nodes WHERE layer = 'file' AND json_array_length(metadata, '$.unresolvedImports') > 0 ORDER BY path",
    ).map((row) => [row.path, JSON.parse(row.list)]),
  );
}

test('C/C++: namespaces, classes, out-of-line methods and C structs become symbols', () => {
  const db = indexed(CPP_APP);
  assert.deepEqual(symbolList(db), [
    'sym:include/geometry/vector.hpp#geo::Vec2 class 5-9',
    'sym:include/geometry/vector.hpp#geo::Vec2::scaled method 8-8',
    'sym:legacy/config.c#Config class 1-3',
    'sym:legacy/config.c#clamp function 5-5',
    'sym:legacy/config.c#config_width function 7-9',
    'sym:src/main.cpp#main function 3-7',
    'sym:src/physics.cpp#Body::integrate method 13-15',
    'sym:src/physics.cpp#Body::step method 6-11',
    'sym:src/physics.cpp#helper function 17-17',
    'sym:src/physics.hpp#Body class 4-11',
    'sym:src/vector.cpp#geo::Vec2::length method 6-8',
    'sym:src/vector.cpp#geo::dot function 10-12',
  ]);
  // static functions are file-local
  const exported = (id: string) => rows<{ e: number }>(db, "SELECT json_extract(metadata, '$.exported') AS e FROM nodes WHERE id = ?", id)[0]!.e;
  assert.equal(exported('sym:src/physics.cpp#helper'), 0);
  assert.equal(exported('sym:legacy/config.c#clamp'), 0);
  assert.equal(exported('sym:src/physics.cpp#Body::step'), 1);
  assert.equal(rows<{ language: string }>(db, "SELECT language FROM nodes WHERE id = 'file:legacy/config.c'")[0]!.language, 'c');
});

test('C/C++: includes beside the file are deterministic, found by suffix are heuristic, system and library headers are external', () => {
  const db = indexed(CPP_APP);
  assert.deepEqual(edgeList(db, 'imports'), [
    'file:src/main.cpp -> file:src/physics.hpp [deterministic 1]',
    'file:src/physics.cpp -> ext:lib:fmt [deterministic 1]',
    'file:src/physics.cpp -> ext:std:vector [deterministic 1]',
    'file:src/physics.cpp -> file:src/physics.hpp [deterministic 1]',
    'file:src/physics.hpp -> file:include/geometry/vector.hpp [deterministic 1]',
    'file:src/vector.cpp -> ext:std:cmath [deterministic 1]',
    'file:src/vector.cpp -> file:include/geometry/vector.hpp [heuristic 0.9]',
  ]);
  assert.deepEqual(unresolved(db), { 'src/physics.cpp': ['missing.h'] });
});

test('C/C++: calls are heuristic, ranked by how much context backs the name match', () => {
  const db = indexed(CPP_APP);
  assert.deepEqual(edgeList(db, 'calls'), [
    'sym:legacy/config.c#config_width -> sym:legacy/config.c#clamp [heuristic 0.9]',
    'sym:src/main.cpp#main -> sym:src/physics.cpp#Body::step [heuristic 0.6]',
    'sym:src/main.cpp#main -> sym:src/physics.hpp#Body [heuristic 0.85]',
    'sym:src/physics.cpp#Body::integrate -> sym:src/vector.cpp#geo::Vec2::length [heuristic 0.5]',
    'sym:src/physics.cpp#Body::step -> sym:include/geometry/vector.hpp#geo::Vec2::scaled [heuristic 0.5]',
    'sym:src/physics.cpp#Body::step -> sym:src/physics.cpp#Body::integrate [heuristic 0.85]',
    'sym:src/physics.cpp#Body::step -> sym:src/vector.cpp#geo::dot [heuristic 0.8]',
    'sym:src/vector.cpp#geo::Vec2::length -> sym:src/vector.cpp#geo::dot [heuristic 0.9]',
  ]);
  const evidence = rows<{ file_path: string; start_line: number; rule: string }>(
    db,
    `SELECT ev.file_path, ev.start_line, ev.rule FROM edges e
       JOIN edge_evidence ee ON ee.edge_id = e.id JOIN evidence ev ON ev.id = ee.evidence_id
      WHERE e.source = 'sym:src/vector.cpp#geo::Vec2::length' AND e.target = 'sym:src/vector.cpp#geo::dot'`,
  );
  assert.deepEqual(evidence, [{ file_path: 'src/vector.cpp', start_line: 7, rule: 'tree-sitter-cpp:call-expression' }]);
});

test('C/C++: the main path starts at the file with main()', () => {
  const db = indexed(CPP_APP);
  const path = mainPath(db, CPP_APP);
  assert.ok(path);
  assert.equal(path.nodes[0], 'file:src/main.cpp');
});

test('Python: functions, classes and methods become symbols; underscore names are private', () => {
  const db = indexed(PYTHON_APP);
  assert.deepEqual(symbolList(db), [
    'sym:app/models.py#User class 1-9',
    'sym:app/models.py#User.__init__ method 2-3',
    'sym:app/models.py#User._format method 8-9',
    'sym:app/models.py#User.greet method 5-6',
    'sym:app/service.py#Service class 7-15',
    'sym:app/service.py#Service.create method 8-12',
    'sym:app/service.py#Service.log method 14-15',
    'sym:app/service.py#fetch function 18-20',
    'sym:app/storage.py#_write function 10-11',
    'sym:app/storage.py#save function 5-7',
    'sym:scripts/run.py#main function 6-9',
  ]);
  const exported = rows<{ id: string }>(db, "SELECT id FROM nodes WHERE layer = 'symbol' AND json_extract(metadata, '$.exported') = 0 ORDER BY id");
  assert.deepEqual(exported.map((row) => row.id), ['sym:app/models.py#User.__init__', 'sym:app/models.py#User._format', 'sym:app/storage.py#_write']);
});

test('Python: package, relative and submodule imports resolve to files; stdlib and PyPI are external', () => {
  const db = indexed(PYTHON_APP);
  assert.deepEqual(edgeList(db, 'imports'), [
    'file:app/__init__.py -> file:app/service.py [deterministic 1]',
    'file:app/service.py -> ext:pypi:requests [deterministic 1]',
    'file:app/service.py -> ext:python:json [deterministic 1]',
    'file:app/service.py -> file:app/__init__.py [deterministic 1]',
    'file:app/service.py -> file:app/models.py [deterministic 1]',
    'file:app/service.py -> file:app/storage.py [deterministic 1]',
    'file:app/storage.py -> ext:python:os [deterministic 1]',
    'file:app/storage.py -> ext:python:typing [deterministic 1]',
    'file:scripts/run.py -> file:app/service.py [deterministic 1]',
    'file:scripts/run.py -> file:app/storage.py [deterministic 1]',
  ]);
  assert.deepEqual(unresolved(db), { 'scripts/run.py': ['.nope'] });
});

test('Python: calls through imported names, self and modules; attribute calls on unknown objects are weaker guesses', () => {
  const db = indexed(PYTHON_APP);
  assert.deepEqual(edgeList(db, 'calls'), [
    'file:scripts/run.py -> sym:scripts/run.py#main [heuristic 0.9]',
    'sym:app/models.py#User.greet -> sym:app/models.py#User._format [heuristic 0.85]',
    'sym:app/service.py#Service.create -> ext:python:json [heuristic 0.9]',
    'sym:app/service.py#Service.create -> sym:app/models.py#User [heuristic 0.9]',
    'sym:app/service.py#Service.create -> sym:app/models.py#User.greet [heuristic 0.5]',
    'sym:app/service.py#Service.create -> sym:app/service.py#Service.log [heuristic 0.85]',
    'sym:app/service.py#Service.create -> sym:app/storage.py#save [heuristic 0.9]',
    'sym:app/service.py#fetch -> ext:pypi:requests [heuristic 0.9]',
    'sym:app/storage.py#save -> ext:python:os [heuristic 0.9]',
    'sym:app/storage.py#save -> sym:app/storage.py#_write [heuristic 0.9]',
    'sym:scripts/run.py#main -> sym:app/service.py#Service [heuristic 0.9]',
    'sym:scripts/run.py#main -> sym:app/service.py#Service.create [heuristic 0.5]',
    'sym:scripts/run.py#main -> sym:app/storage.py#save [heuristic 0.9]',
  ]);
});

test('vendored code and Python/CMake build output are never indexed', () => {
  const db = indexed(
    makeRepo({
      'src/app.cpp': 'int main() { return 0; }\n',
      'src/tool.py': 'def run():\n    pass\n',
      'third_party/zlib/zlib.c': 'int inflate() { return 0; }\n',
      '3rdparty/json.hpp': 'struct Json {};\n',
      'vendor/lib.h': 'void f();\n',
      'src/__pycache__/tool.cpython-312.py': 'x = 1\n',
      '.venv/lib/site.py': 'x = 1\n',
      'cmake-build-debug/gen.cpp': 'int g() { return 0; }\n',
    }),
  );
  assert.deepEqual(
    rows<{ path: string }>(db, "SELECT path FROM nodes WHERE layer = 'file' ORDER BY path").map((row) => row.path),
    ['src/app.cpp', 'src/tool.py'],
  );
});

test('a full re-index runs when the extractor version changes', () => {
  const root = makeRepo({ 'main.c': 'int main(void) { return 0; }\n' });
  const db = openDatabase(':memory:');
  indexRepository(db, root);
  assert.equal(indexRepository(db, root).parsed, 0);
  // An index built before C/C++ support had no symbols for this file.
  db.prepare("UPDATE meta SET value = '1' WHERE key = 'extractor_version'").run();
  assert.equal(indexRepository(db, root).parsed, 1);
});
