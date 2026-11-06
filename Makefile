# Build: `make` on macOS / Linux, or on Windows in an MSYS2 UCRT64 shell. Needs a C++17 compiler; libcurl on macOS / Linux
# (preinstalled on macOS), WinHTTP on Windows. This builds the engine's command line (`./soloptima simulate|optimize`) and
# its tests. The desktop app is src-tauri (cargo build -p soloptima-app), which compiles the same sources; see docs/ipc.md.
CXX ?= c++
CXXFLAGS ?= -std=c++17 -O3 -Wall -Wextra -Wno-unused-parameter
# the version in src/version.hpp unless given
VERSION := $(or $(VERSION),$(shell sed -n 's/.*define SOLOPTIMA_VERSION "\(.*\)"/\1/p' src/version.hpp))
CXXFLAGS += -DSOLOPTIMA_VERSION=\"$(VERSION)\"

SRC = $(wildcard src/*.cpp)
OBJ = $(SRC:src/%.cpp=build/%.o)
ifeq ($(OS),Windows_NT)
  CXXFLAGS += -D_WIN32_WINNT=0x0A00 -DNOMINMAX
  LIBS = -static -static-libgcc -static-libstdc++ -lws2_32 -lwinhttp -lshell32 -lole32 -luuid -ladvapi32
  LDLIBS = $(LIBS)
  EXE = .exe
else ifeq ($(shell uname -s),Darwin)
  LIBS = -lcurl -lpthread
  LDLIBS = $(LIBS)
else
  LIBS = -lcurl -lpthread -ldl
  LDLIBS = $(LIBS)
endif
BIN = soloptima$(EXE)
TEST = build/test_engine$(EXE)

all: $(BIN)

$(BIN): $(OBJ)
	$(CXX) $(CXXFLAGS) -o $@ $^ $(LDLIBS)

build/%.o: src/%.cpp src/*.hpp | build
	$(CXX) $(CXXFLAGS) -c -o $@ $<

build:
	mkdir -p build

test: $(BIN) $(TEST)
	./$(TEST)
	@if command -v node >/dev/null 2>&1; then node tests/layout_geometry.test.js && node --test ui/tests/*.test.js; else echo "Node not found: the layout geometry and interface tests were skipped"; fi

# The Svelte interface (ui/) into web/ui/, which the desktop app loads; see docs/ui.md
ui:
	npm --prefix ui ci --no-audit --no-fund
	npm --prefix ui run build

# the engine without its window, so the tests need no desktop libraries (and run as a console program on Windows)
$(TEST): tests/test_engine.cpp $(filter-out build/main.o,$(OBJ))
	$(CXX) $(CXXFLAGS) -Isrc -o $@ $^ $(LIBS)

clean:
	rm -rf build $(BIN)

# Installers of this system in dist/ (Tauri bundles), then the release signature: see README "Packaging and releases"
dist:
	./packaging/bundle.sh

.PHONY: all test clean dist ui
