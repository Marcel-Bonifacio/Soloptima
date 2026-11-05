// Version and release source of this build. The Makefile and the packaging scripts take the version from here unless
// given one (make dist VERSION=1.2.0) and pass it as -DSOLOPTIMA_VERSION. A fork that publishes its own releases passes
// -DSOLOPTIMA_REPO=owner/name, so its builds look for updates there.
#pragma once
#ifndef SOLOPTIMA_VERSION
#define SOLOPTIMA_VERSION "1.1.0"
#endif
#ifndef SOLOPTIMA_REPO
#define SOLOPTIMA_REPO "Marcel-Bonifacio/Soloptima"
#endif
