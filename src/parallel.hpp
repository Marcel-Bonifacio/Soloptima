// Runs fn(i) for every i < n on at most `threads` threads. The first exception stops the remaining work and is rethrown
// in the caller's thread (an exception escaping a std::thread would end the program).
#pragma once
#include <algorithm>
#include <atomic>
#include <exception>
#include <mutex>
#include <thread>
#include <vector>

template <class F>
void parallel_for(size_t n, size_t threads, F fn) {
    std::atomic<size_t> next{0};
    std::mutex m;
    std::exception_ptr err;
    std::vector<std::thread> pool;
    for (size_t k = 0; k < std::min(n, threads); ++k)
        pool.emplace_back([&] {
            for (size_t i; (i = next.fetch_add(1)) < n;) {
                try { fn(i); } catch (...) {
                    std::lock_guard<std::mutex> g(m);
                    if (!err) err = std::current_exception();
                    next = n;
                }
            }
        });
    for (auto& t : pool) t.join();
    if (err) std::rethrow_exception(err);
}
