package com.nttdocomo.io;

import java.io.IOException;

import rdash.Host;

/** An open SD-card file. Content is held in memory and written back to the host on flush/close. */
public class FileEntity {
    final String name;
    byte[] data;
    int size;
    boolean dirty;

    public FileEntity(String name, int mode) throws IOException {
        this.name = name;
        byte[] b = Host.sdRead(name);
        if (b == null) {
            throw new IOException(name);
        }
        data = new byte[Math.max(b.length, 16)];
        System.arraycopy(b, 0, data, 0, b.length);
        size = b.length;
    }

    void ensure(int n) {
        if (n > data.length) {
            byte[] d = new byte[Math.max(n, data.length * 2)];
            System.arraycopy(data, 0, d, 0, size);
            data = d;
        }
    }

    void sync() {
        if (dirty) {
            Host.sdWrite(name, data, size);
            dirty = false;
        }
    }

    public FileDataInput openDataInput() throws IOException {
        return new FileDataInput(this);
    }

    public FileDataOutput openDataOutput() throws IOException {
        return new FileDataOutput(this);
    }

    public void close() throws IOException {
        sync();
    }
}
