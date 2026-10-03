package com.nttdocomo.io;

import java.io.DataOutput;
import java.io.IOException;

public class FileDataOutput implements DataOutput, RandomAccessible {
    private final FileEntity f;
    private int pos;

    FileDataOutput(FileEntity f) {
        this.f = f;
    }

    public void close() throws IOException {
        f.sync();
    }

    public void flush() throws IOException {
        f.sync();
    }

    public void setPosition(long p) throws IOException {
        pos = (int) p;
    }

    public long getPosition() throws IOException {
        return pos;
    }

    public long getSize() throws IOException {
        return f.size;
    }

    public void write(int b) throws IOException {
        f.ensure(pos + 1);
        f.data[pos++] = (byte) b;
        f.size = Math.max(f.size, pos);
        f.dirty = true;
    }

    public void write(byte[] b) throws IOException {
        write(b, 0, b.length);
    }

    public void write(byte[] b, int off, int len) throws IOException {
        f.ensure(pos + len);
        System.arraycopy(b, off, f.data, pos, len);
        pos += len;
        f.size = Math.max(f.size, pos);
        f.dirty = true;
    }

    public void writeBoolean(boolean v) throws IOException {
        write(v ? 1 : 0);
    }

    public void writeByte(int v) throws IOException {
        write(v);
    }

    public void writeShort(int v) throws IOException {
        write(v >> 8);
        write(v);
    }

    public void writeChar(int v) throws IOException {
        writeShort(v);
    }

    public void writeInt(int v) throws IOException {
        writeShort(v >> 16);
        writeShort(v);
    }

    public void writeLong(long v) throws IOException {
        writeInt((int) (v >> 32));
        writeInt((int) v);
    }

    public void writeFloat(float v) throws IOException {
        writeInt(Float.floatToIntBits(v));
    }

    public void writeDouble(double v) throws IOException {
        writeLong(Double.doubleToLongBits(v));
    }

    public void writeBytes(String s) throws IOException {
        for (int i = 0; i < s.length(); i++) {
            write(s.charAt(i));
        }
    }

    public void writeChars(String s) throws IOException {
        for (int i = 0; i < s.length(); i++) {
            writeChar(s.charAt(i));
        }
    }

    public void writeUTF(String s) throws IOException {
        byte[] b = s.getBytes("UTF-8");
        writeShort(b.length);
        write(b);
    }
}
