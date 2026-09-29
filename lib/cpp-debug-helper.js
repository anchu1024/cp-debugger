"use strict";

function debugHelperSource() {
    return `// CPDBG-BEGIN HELPERS
namespace cpdbg {
template <class T> void write(const T& value);
template <class A, class B> void write(const std::pair<A, B>& value);
template <class... T> void write(const std::tuple<T...>& value);
template <class T> void write(const T& value) {
    if constexpr (std::is_same_v<std::decay_t<T>, std::string>) {
        std::cerr << value;
    } else if constexpr (requires { value.begin(); value.end(); }) {
        std::cerr << '[';
        bool first = true;
        for (const auto& item : value) { if (!first) std::cerr << ", "; first = false; write(item); }
        std::cerr << ']';
    } else if constexpr (requires { value.size(); }) {
        std::cerr << "size=" << value.size();
    } else if constexpr (std::is_same_v<std::decay_t<T>, bool>) {
        std::cerr << (value ? "true" : "false");
    } else {
        std::cerr << value;
    }
}
template <class A, class B> void write(const std::pair<A, B>& value) {
    std::cerr << '('; write(value.first); std::cerr << ", "; write(value.second); std::cerr << ')';
}
template <class... T> void write(const std::tuple<T...>& value) {
    std::cerr << '(';
    std::size_t index = 0;
    std::apply([&](const auto&... item) { ((std::cerr << (index++ ? ", " : ""), write(item)), ...); }, value);
    std::cerr << ')';
}
template <class T> void print(const char* label, const T& value) {
    std::cerr << "[CPDBG] " << label << " = "; write(value); std::cerr << '\\n';
}
}
// CPDBG-END
`;
}

module.exports = { debugHelperSource };
