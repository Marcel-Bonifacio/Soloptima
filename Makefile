# Build: `make` on macOS / Linux, or on Windows in an MSYS2 UCRT64 shell. Needs a C++17 compiler; libcurl on macOS / Linux
# (preinstalled on macOS), WinHTTP on Windows (part of the system).
CXX ?= c++
CXXFLAGS ?= -std=c++17 -O3 -Wall -Wextra -Wno-unused-parameter
VERSION ?= 1.0.0
CXXFLAGS += -DSOLOPTIMA_VERSION=\"$(VERSION)\"
ifeq ($(OS),Windows_NT)
  CXXFLAGS += -D_WIN32_WINNT=0x0A00 -DNOMINMAX
  LDLIBS = -static -static-libgcc -static-libstdc++ -lws2_32 -lwinhttp -lshell32
  EXE = .exe
else
  LDLIBS = -lcurl -lpthread
endif

SRC = $(wildcard src/*.cpp)
OBJ = $(SRC:src/%.cpp=build/%.o)
BIN = soloptima$(EXE)
TEST = build/test_engine$(EXE)

all: $(BIN)

$(BIN): $(OBJ)
	$(CXX) $(CXXFLAGS) -o $@ $^ $(LDLIBS)

build/%.o: src/%.cpp src/*.hpp | build
	$(CXX) $(CXXFLAGS) -c -o $@ $<

build:
	mkdir -p build

run: $(BIN)
	./$(BIN) serve

test: $(BIN) $(TEST)
	./$(TEST)

$(TEST): tests/test_engine.cpp $(filter-out build/main.o,$(OBJ))
	$(CXX) $(CXXFLAGS) -Isrc -o $@ $^ $(LDLIBS)

clean:
	rm -rf build $(BIN)

# Distributable builds: macOS universal app (.app + .dmg) and Windows x64 (.exe + .zip, cross-compiled with mingw-w64)
dist-mac:
	./packaging/build-mac.sh $(VERSION)

dist-windows:
	./packaging/build-windows.sh $(VERSION)

dist: dist-mac dist-windows

.PHONY: all run test clean dist dist-mac dist-windows
