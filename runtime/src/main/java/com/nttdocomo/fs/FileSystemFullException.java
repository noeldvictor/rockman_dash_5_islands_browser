package com.nttdocomo.fs;

import java.io.IOException;

public class FileSystemFullException extends IOException {
    public FileSystemFullException() {
    }

    public FileSystemFullException(String msg) {
        super(msg);
    }
}
