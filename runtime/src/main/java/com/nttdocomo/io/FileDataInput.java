package com.nttdocomo.io;

import java.io.DataInput;
import java.io.EOFException;
import java.io.IOException;

public class FileDataInput implements DataInput, RandomAccessible {
    private final FileEntity f;
    private int pos;

    FileDataInput(FileEntity f) {
        this.f = f;
    }

    public void close() throws IOException {
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

    private int next() throws IOException {
        if (pos >= f.size) {
            throw new EOFException();
        }
        return f.data[pos++] & 0xFF;
    }

    public void readFully(byte[] b) throws IOException {
        readFully(b, 0, b.length);
    }

    public void readFully(byte[] b, int off, int len) throws IOException {
        if (pos + len > f.size) {
            throw new EOFException();
        }
        System.arraycopy(f.data, pos, b, off, len);
        pos += len;
    }

    public int skipBytes(int n) throws IOException {
        int k = Math.max(0, Math.min(n, f.size - pos));
        pos += k;
        return k;
    }

    public boolean readBoolean() throws IOException {
        return next() != 0;
    }

    public byte readByte() throws IOException {
        return (byte) next();
    }

    public int readUnsignedByte() throws IOException {
        return next();
    }

    public short readShort() throws IOException {
        return (short) readUnsignedShort();
    }

    public int readUnsignedShort() throws IOException {
        int a = next();
        return a << 8 | next();
    }

    public char readChar() throws IOException {
        return (char) readUnsignedShort();
    }

    public int readInt() throws IOException {
        int a = readUnsignedShort();
        return a << 16 | readUnsignedShort();
    }

    public long readLong() throws IOException {
        long a = readInt();
        return a << 32 | (readInt() & 0xFFFFFFFFL);
    }

    public float readFloat() throws IOException {
        return Float.intBitsToFloat(readInt());
    }

    public double readDouble() throws IOException {
        return Double.longBitsToDouble(readLong());
    }

    public String readLine() throws IOException {
        StringBuilder sb = new StringBuilder();
        while (pos < f.size) {
            int c = next();
            if (c == '\n') {
                break;
            }
            if (c != '\r') {
                sb.append((char) c);
            }
        }
        return sb.toString();
    }

    public String readUTF() throws IOException {
        int n = readUnsignedShort();
        byte[] b = new byte[n];
        readFully(b);
        return new String(b, "UTF-8");
    }
}
