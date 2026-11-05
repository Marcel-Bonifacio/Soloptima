# Build: `make` on macOS / Linux, or on Windows in an MSYS2 UCRT64 shell. Needs a C++17 compiler; libcurl on macOS / Linux
# (preinstalled on macOS), WinHTTP and the WebView2 SDK on Windows (fetched by packaging/windows/fetch-webview2.sh).
# `./soloptima` opens the desktop window on macOS and Windows; `./soloptima serve` shows the interface in the browser.
CXX ?= c++
CXXFLAGS ?= -std=c++17 -O3 -Wall -Wextra -Wno-unused-parameter
# the version in src/version.hpp unless given (make dist VERSION=1.2.0)
VERSION := $(or $(VERSION),$(shell sed -n 's/.*define SOLOPTIMA_VERSION "\(.*\)"/\1/p' src/version.hpp))
CXXFLAGS += -DSOLOPTIMA_VERSION=\"$(VERSION)\"

SRC = $(wildcard src/*.cpp)
OBJ = $(SRC:src/%.cpp=build/%.o)
ifeq ($(OS),Windows_NT)
  CXXFLAGS += -D_WIN32_WINNT=0x0A00 -DNOMINMAX -isystem build/webview2/include
  LIBS = -static -static-libgcc -static-libstdc++ -lws2_32 -lwinhttp -lshell32 -lole32 -luuid -ladvapi32 -lwintrust -lcrypt32
  LDLIBS = -mwindows $(LIBS)
  EXE = .exe
  WEBVIEW2 = build/webview2/include/WebView2.h
  EXTRA = WebView2Loader.dll
  RES = build/app.res.o
else ifeq ($(shell uname -s),Darwin)
  OBJ += build/app_mac.o
  LIBS = -lcurl -lpthread -framework Security -framework CoreFoundation
  LDLIBS = $(LIBS) -framework Cocoa -framework WebKit
else
  LIBS = -lcurl -lpthread -ldl
  LDLIBS = $(LIBS)
endif
BIN = soloptima$(EXE)
TEST = build/test_engine$(EXE)

all: $(BIN) $(EXTRA)

$(BIN): $(OBJ) $(RES)
	$(CXX) $(CXXFLAGS) -o $@ $^ $(LDLIBS)

# Windows: icon, manifest and version information, as in the release build
$(RES): packaging/windows/resources.sh packaging/windows/app.manifest packaging/make_icons.py | build
	./packaging/windows/resources.sh $(VERSION) build

build/%.o: src/%.cpp src/*.hpp $(WEBVIEW2) | build
	$(CXX) $(CXXFLAGS) -c -o $@ $<

build/app_mac.o: src/app_mac.mm src/app.hpp | build
	$(CXX) $(CXXFLAGS) -fobjc-arc -x objective-c++ -c -o $@ $<

$(WEBVIEW2):
	./packaging/windows/fetch-webview2.sh

WebView2Loader.dll: $(WEBVIEW2)
	cp build/webview2/WebView2Loader.dll $@

build:
	mkdir -p build

run: all
	./$(BIN)

test: $(BIN) $(TEST)
	./$(TEST)

# the engine without its window, so the tests need no desktop libraries (and run as a console program on Windows)
$(TEST): tests/test_engine.cpp $(filter-out build/main.o build/app_%.o,$(OBJ))
	$(CXX) $(CXXFLAGS) -Isrc -o $@ $^ $(LIBS)

clean:
	rm -rf build $(BIN) WebView2Loader.dll

# Installers: macOS universal app (.app in a .dmg), Windows x64 (setup program and .zip) and Linux x86_64 (.AppImage and
# .tar.gz; on a Mac through Docker), plus dist/SHA256SUMS.txt for the release. They are code-signed when the signing variables are set (see README, "Signing").
dist-mac:
	./packaging/build-mac.sh $(VERSION)

dist-windows:
	./packaging/build-windows.sh $(VERSION)

dist-linux:
	./packaging/build-linux.sh $(VERSION)

dist: dist-mac dist-windows dist-linux
	./packaging/checksums.sh

.PHONY: all run test clean dist dist-mac dist-windows dist-linux
