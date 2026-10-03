package javax.microedition.io;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

import org.teavm.jso.JSObject;

import com.nttdocomo.io.ConnectionException;
import com.nttdocomo.io.HttpConnection;

import rdash.Host;

/**
 * i-appli connection URLs:
 *   resource:///name                      a file inside the application jar
 *   scratchpad:///N;pos=P,length=L        segment N of the application's persistent scratchpad
 *   http://...                            answered by the host's stand-in for the game server
 */
public class Connector {
    public static final int READ = 1;
    public static final int WRITE = 2;
    public static final int READ_WRITE = 3;

    private Connector() {
    }

    public static Connection open(String name) throws IOException {
        return open(name, READ_WRITE, false);
    }

    public static Connection open(String name, int mode) throws IOException {
        return open(name, mode, false);
    }

    public static Connection open(String name, int mode, boolean timeouts) throws IOException {
        if (name.startsWith("http://") || name.startsWith("https://")) {
            return new Http(name);
        }
        throw new IllegalArgumentException(name);
    }

    public static InputStream openInputStream(String name) throws IOException {
        if (name.startsWith("resource:///")) {
            byte[] b = Host.resource(name.substring(12));
            if (b == null) {
                throw new ConnectionException(ConnectionException.NO_RESOURCE, name);
            }
            return new ByteArrayInputStream(b);
        }
        if (name.startsWith("scratchpad:///")) {
            int[] r = scratchpadRange(name);
            byte[] b = Host.spRead(r[0], r[1], r[2]);
            if (b == null) {
                throw new ConnectionException(ConnectionException.SCRATCHPAD_OVERSIZE, name);
            }
            return new ByteArrayInputStream(b);
        }
        return ((InputConnection) open(name, READ, false)).openInputStream();
    }

    public static DataInputStream openDataInputStream(String name) throws IOException {
        return new DataInputStream(openInputStream(name));
    }

    public static OutputStream openOutputStream(String name) throws IOException {
        if (name.startsWith("scratchpad:///")) {
            final int[] r = scratchpadRange(name);
            return new ByteArrayOutputStream() {
                private int written;

                private void sync() {
                    if (count > written) {
                        Host.spWrite(r[0], r[1], buf, count);
                        written = count;
                    }
                }

                @Override
                public void flush() {
                    sync();
                }

                @Override
                public void close() {
                    sync();
                }
            };
        }
        return ((OutputConnection) open(name, WRITE, false)).openOutputStream();
    }

    public static DataOutputStream openDataOutputStream(String name) throws IOException {
        return new DataOutputStream(openOutputStream(name));
    }

    /** {segment, pos, length} with -1 for an absent length. */
    private static int[] scratchpadRange(String name) {
        String s = name.substring(14);
        int[] r = {0, 0, -1};
        int semi = s.indexOf(';');
        String seg = semi < 0 ? s : s.substring(0, semi);
        if (seg.length() > 0) {
            r[0] = Integer.parseInt(seg);
        }
        if (semi >= 0) {
            String rest = s.substring(semi + 1);
            int i = 0;
            while (i < rest.length()) {
                int j = rest.indexOf(',', i);
                if (j < 0) {
                    j = rest.length();
                }
                String kv = rest.substring(i, j);
                int eq = kv.indexOf('=');
                if (eq > 0) {
                    int v = Integer.parseInt(kv.substring(eq + 1));
                    if (kv.startsWith("pos")) {
                        r[1] = v;
                    } else if (kv.startsWith("length")) {
                        r[2] = v;
                    }
                }
                i = j + 1;
            }
        }
        return r;
    }

    private static final class Http implements HttpConnection {
        private final String url;
        private String method = GET;
        private ByteArrayOutputStream body;
        private int code = -1;
        private byte[] response;

        Http(String url) {
            this.url = url;
        }

        public void setRequestMethod(String method) {
            this.method = method;
        }

        public void setRequestProperty(String key, String value) {
        }

        public void connect() throws IOException {
            byte[] b = body == null ? null : body.toByteArray();
            JSObject r = Host.httpRequest(url, method, b, b == null ? 0 : b.length);
            code = Host.httpCode(r);
            response = Host.httpBody(r);
            if (code <= 0) {
                throw new ConnectionException(ConnectionException.OUT_OF_SERVICE, url);
            }
        }

        public int getResponseCode() {
            return code;
        }

        public String getResponseMessage() {
            return code == 200 ? "OK" : "";
        }

        public String getHeaderField(String name) {
            return null;
        }

        public String getURL() {
            return url;
        }

        public String getType() {
            return "application/octet-stream";
        }

        public String getEncoding() {
            return null;
        }

        public long getLength() {
            return response == null ? -1 : response.length;
        }

        public InputStream openInputStream() {
            return new ByteArrayInputStream(response == null ? new byte[0] : response);
        }

        public DataInputStream openDataInputStream() {
            return new DataInputStream(openInputStream());
        }

        public OutputStream openOutputStream() {
            if (body == null) {
                body = new ByteArrayOutputStream();
            }
            return body;
        }

        public DataOutputStream openDataOutputStream() {
            return new DataOutputStream(openOutputStream());
        }

        public void close() {
        }
    }
}
