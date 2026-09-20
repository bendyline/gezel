#ifndef GEZEL_UTF8_STREAM_H
#define GEZEL_UTF8_STREAM_H

#include <string>

namespace gezel_mobile {

// Tokens may split a Unicode scalar. Hold only an incomplete trailing scalar;
// malformed byte sequences become U+FFFD and never cross the native bridge.
class utf8_stream {
    std::string pending;
public:
    std::string append(const char * bytes, size_t length, bool finish = false) {
        pending.append(bytes, length);
        std::string result;
        size_t offset = 0;
        while (offset < pending.size()) {
            const auto first = static_cast<unsigned char>(pending[offset]);
            size_t width = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 :
                first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
            if (width == 0) {
                result += "\xef\xbf\xbd";
                ++offset;
                continue;
            }
            bool valid = true;
            for (size_t i = 1; i < width && offset + i < pending.size(); ++i) {
                const auto next = static_cast<unsigned char>(pending[offset + i]);
                if ((next & 0xc0) != 0x80 || (i == 1 &&
                    ((first == 0xe0 && next < 0xa0) || (first == 0xed && next >= 0xa0) ||
                     (first == 0xf0 && next < 0x90) || (first == 0xf4 && next >= 0x90)))) valid = false;
            }
            if (!valid) {
                result += "\xef\xbf\xbd";
                ++offset;
                continue;
            }
            if (offset + width > pending.size()) {
                if (finish) { result += "\xef\xbf\xbd"; offset = pending.size(); }
                break;
            }
            result.append(pending, offset, width);
            offset += width;
        }
        pending.erase(0, offset);
        return result;
    }

    static bool valid(const char * bytes, size_t length) {
        utf8_stream stream;
        return stream.append(bytes, length, true) == std::string(bytes, length);
    }
};
}
#endif
