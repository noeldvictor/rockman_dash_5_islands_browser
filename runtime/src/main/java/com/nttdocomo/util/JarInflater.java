package com.nttdocomo.util;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

import org.teavm.jso.JSObject;

import rdash.Host;
import rdash.Streams;

/** Random access to the entries of a jar/zip held in memory (decompression is done by the host). */
public class JarInflater {
    private JSObject zip;

    public JarInflater(InputStream in) throws IOException {
        this(Streams.readAll(in));
    }

    public JarInflater(byte[] data) {
        zip = Host.unzip(data, data.length);
    }

    public void close() {
        zip = null;
    }

    public long getSize(String name) {
        byte[] b = zip == null ? null : Host.zipEntry(zip, name);
        return b == null ? -1 : b.length;
    }

    public InputStream getInputStream(String name) {
        byte[] b = zip == null ? null : Host.zipEntry(zip, name);
        return b == null ? null : new ByteArrayInputStream(b);
    }
}
