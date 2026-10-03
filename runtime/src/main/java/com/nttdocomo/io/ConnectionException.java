package com.nttdocomo.io;

import java.io.IOException;

public class ConnectionException extends IOException {
    public static final int UNDEFINED = 0;
    public static final int ILLEGAL_STATE = 1;
    public static final int NO_RESOURCE = 2;
    public static final int RESOURCE_BUSY = 3;
    public static final int NO_USE = 4;
    public static final int OUT_OF_SERVICE = 5;
    public static final int IMODE_LOCKED = 6;
    public static final int TIMEOUT = 7;
    public static final int USER_ABORT = 8;
    public static final int SYSTEM_ABORT = 9;
    public static final int HTTP_ERROR = 10;
    public static final int SCRATCHPAD_OVERSIZE = 11;

    private final int status;

    public ConnectionException() {
        this(UNDEFINED);
    }

    public ConnectionException(int status) {
        this.status = status;
    }

    public ConnectionException(int status, String msg) {
        super(msg);
        this.status = status;
    }

    public int getStatus() {
        return status;
    }
}
