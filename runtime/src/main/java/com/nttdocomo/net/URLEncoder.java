package com.nttdocomo.net;

public class URLEncoder {
    private URLEncoder() {
    }

    public static String encode(String s) {
        StringBuilder sb = new StringBuilder();
        byte[] bytes;
        try {
            bytes = s.getBytes("UTF-8");
        } catch (java.io.UnsupportedEncodingException e) {
            bytes = s.getBytes();
        }
        for (byte value : bytes) {
            int c = value & 0xFF;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '.' || c == '-' || c == '*' || c == '_') {
                sb.append((char) c);
            } else if (c == ' ') {
                sb.append('+');
            } else {
                sb.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16)))
                        .append(Character.toUpperCase(Character.forDigit(c & 15, 16)));
            }
        }
        return sb.toString();
    }
}
