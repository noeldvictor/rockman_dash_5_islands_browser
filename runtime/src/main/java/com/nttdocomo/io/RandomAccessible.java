package com.nttdocomo.io;

import java.io.IOException;

public interface RandomAccessible {
    void setPosition(long pos) throws IOException;

    long getPosition() throws IOException;

    long getSize() throws IOException;
}
