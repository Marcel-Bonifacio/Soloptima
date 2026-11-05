#include "signature.hpp"
#include "vendor/monocypher/monocypher-ed25519.h"
#include <algorithm>
#include <sstream>
#include <stdexcept>

namespace {

// Standard base64 with padding; any other character is refused rather than skipped
std::vector<uint8_t> from_base64(const std::string& s) {
    static const std::string digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const auto bad = [] { return std::runtime_error("The signature or key is not valid base64."); };
    if (s.empty() || s.size() % 4 != 0) throw bad();
    const size_t pad = s.size() - 1 - s.find_last_not_of('=');
    if (pad > 2) throw bad();
    std::vector<uint8_t> out;
    uint32_t acc = 0;
    for (size_t i = 0; i < s.size() - pad; ++i) {
        const size_t v = digits.find(s[i]);
        if (v == std::string::npos) throw bad();
        acc = acc << 6 | uint32_t(v);
        if (i % 4 == 3) {
            out.insert(out.end(), {uint8_t(acc >> 16), uint8_t(acc >> 8), uint8_t(acc)});
            acc = 0;
        }
    }
    if (pad == 1) out.insert(out.end(), {uint8_t(acc >> 10), uint8_t(acc >> 2)});   // 18 bits: two bytes
    if (pad == 2) out.push_back(uint8_t(acc >> 4));                                // 12 bits: one byte
    return out;
}

const uint8_t* bytes(const std::string& s) { return reinterpret_cast<const uint8_t*>(s.data()); }

} // namespace

MinisignKey minisign_key(const std::string& base64) {
    const std::vector<uint8_t> b = from_base64(base64);
    if (b.size() != 42 || b[0] != 'E' || b[1] != 'd') throw std::runtime_error("Not a minisign public key.");
    MinisignKey k;
    std::copy(b.begin() + 2, b.begin() + 10, k.id.begin());
    std::copy(b.begin() + 10, b.end(), k.key.begin());
    return k;
}

std::string minisign_verify(const std::string& data, const std::string& sig_file, const std::vector<MinisignKey>& keys) {
    // untrusted comment: ...
    // base64("Ed" or "ED", key id (8), signature (64))   "ED": the signature is of BLAKE2b-512(data)
    // trusted comment: ...
    // base64(signature (64) of the signature above followed by the trusted comment)
    if (sig_file.size() > 4096) throw std::runtime_error("The signature file is too large.");
    std::vector<std::string> lines;
    std::istringstream in(sig_file);
    for (std::string l; lines.size() < 4 && std::getline(in, l);) {
        if (!l.empty() && l.back() == '\r') l.pop_back();
        lines.push_back(l);
    }
    const std::string untrusted = "untrusted comment: ", trusted = "trusted comment: ";
    if (lines.size() < 4 || lines[0].compare(0, untrusted.size(), untrusted) != 0 || lines[2].compare(0, trusted.size(), trusted) != 0)
        throw std::runtime_error("Not a minisign signature.");

    const std::vector<uint8_t> sig = from_base64(lines[1]), global = from_base64(lines[3]);
    if (sig.size() != 74 || sig[0] != 'E' || (sig[1] != 'd' && sig[1] != 'D') || global.size() != 64)
        throw std::runtime_error("Not a minisign signature.");
    const auto key = std::find_if(keys.begin(), keys.end(), [&](const MinisignKey& k) { return std::equal(k.id.begin(), k.id.end(), sig.begin() + 2); });
    if (key == keys.end()) throw std::runtime_error("The file is signed with an unknown key.");

    const uint8_t* s = sig.data() + 10;
    int bad;
    if (sig[1] == 'D') {
        uint8_t hash[64];
        crypto_blake2b(hash, sizeof hash, bytes(data), data.size());
        bad = crypto_ed25519_check(s, key->key.data(), hash, sizeof hash);
    } else {
        bad = crypto_ed25519_check(s, key->key.data(), bytes(data), data.size());
    }
    if (bad) throw std::runtime_error("The signature does not match the file.");

    const std::string comment = lines[2].substr(trusted.size());
    std::vector<uint8_t> signed_comment(s, s + 64);
    signed_comment.insert(signed_comment.end(), comment.begin(), comment.end());
    if (crypto_ed25519_check(global.data(), key->key.data(), signed_comment.data(), signed_comment.size()))
        throw std::runtime_error("The trusted comment of the signature was changed.");
    return comment;
}
