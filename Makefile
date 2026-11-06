# Build: `make` on macOS / Linux, or on Windows in an MSYS2 UCRT64 shell. Needs a C++17 compiler; libcurl on macOS / Linux
# (preinstalled on macOS), WinHTTP on Windows. This builds the engine's command line (`./soloptima simulate|optimize`) and
# its tests. The desktop app is src-tauri (cargo build -p soloptima-app), which compiles the same sources; see docs/ipc.md.
CXX ?= c++
CXXFLAGS ?= -std=c++17 -O3 -Wall -Wextra -Wno-unused-parameter
# the version in src/version.hpp unless given (make dist VERSION=1.2.0)
VERSION := $(or $(VERSION),$(shell sed -n 's/.*define SOLOPTIMA_VERSION "\(.*\)"/\1/p' src/version.hpp))
CXXFLAGS += -DSOLOPTIMA_VERSION=\"$(VERSION)\"

SRC = $(wildcard src/*.cpp)
OBJ = $(SRC:src/%.cpp=build/%.o)
ifeq ($(OS),Windows_NT)
  CXXFLAGS += -D_WIN32_WINNT=0x0A00 -DNOMINMAX
  LIBS = -static -static-libgcc -static-libstdc++ -lws2_32 -lwinhttp -lshell32 -lole32 -luuid -ladvapi32 -lwintrust -lcrypt32
  LDLIBS = $(LIBS)
  EXE = .exe
else ifeq ($(shell uname -s),Darwin)
  LIBS = -lcurl -lpthread -framework Security -framework CoreFoundation
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
	@if command -v node >/dev/null 2>&1; then node tests/layout_geometry.test.js; else echo "Node not found: the layout geometry tests were skipped"; fi

# the engine without its window, so the tests need no desktop libraries (and run as a console program on Windows)
$(TEST): tests/test_engine.cpp $(filter-out build/main.o,$(OBJ))
	$(CXX) $(CXXFLAGS) -Isrc -o $@ $^ $(LIBS)

clean:
	rm -rf build $(BIN)

# Installers: packaging/ (rebuilt around the Tauri bundles in rewrite session 1.3)
dist-mac:
	./packaging/build-mac.sh $(VERSION)

dist-windows:
	./packaging/build-windows.sh $(VERSION)

dist-linux:
	./packaging/build-linux.sh $(VERSION)

dist: dist-mac dist-windows dist-linux
	./packaging/checksums.sh

.PHONY: all test clean dist dist-mac dist-windows dist-linux
