// minisign signatures (Ed25519), as the release checksum list carries them: a signature of the file, or of its BLAKE2b-512
// hash (minisign's default), and a second signature that binds the one-line trusted comment to the first.
// Format: https://jedisct1.github.io/minisign/
#pragma once
#include <array>
#include <cstdint>
#include <string>
#include <vector>

struct MinisignKey {
    std::array<uint8_t, 8> id{};
    std::array<uint8_t, 32> key{};
};

// A minisign public key: the base64 line of a .pub file ("RW..."). Throws std::runtime_error when it is not one.
MinisignKey minisign_key(const std::string& base64);

// Checks a signature (the text of a .minisig file) of `data` against `keys` and returns its trusted comment. Throws
// std::runtime_error when the file is malformed, was made with a key not in `keys`, or either signature fails.
std::string minisign_verify(const std::string& data, const std::string& sig_file, const std::vector<MinisignKey>& keys);
