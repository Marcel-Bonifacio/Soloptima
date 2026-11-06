# Test fixtures

Answers of the C++ engine (v1), which the Rust engine must give to the byte. They were written by the generators
`tests/gen_*_fixtures.cpp` against `src/`, both removed in session 2.12; commit aee1268 is the last that has them. Build
a generator with `-ffp-contract=off` (see its header and docs/ipc.md). The C++ engine is gone, so a fixture cannot be
regenerated any more: change one only for a deliberate change of the engine's answers, and say so in the commit.
