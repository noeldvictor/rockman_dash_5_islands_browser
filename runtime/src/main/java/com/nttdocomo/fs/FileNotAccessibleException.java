package com.nttdocomo.fs;

import java.io.IOException;

public class FileNotAccessibleException extends IOException {
    public static final int UNDEFINED = 0;
    public static final int NOT_FOUND = 1;
    public static final int ALREADY_EXISTS = 3;

    private final int status;

    public FileNotAccessibleException(int status, String msg) {
        super(msg);
        this.status = status;
    }

    public int getStatus() {
        return status;
    }
}
