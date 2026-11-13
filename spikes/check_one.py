import sys, mobi, traceback, os
for f in sys.argv[1:]:
    try:
        tmp, path = mobi.extract(f); print(os.path.basename(f), "OK", os.path.basename(path))
    except Exception as e:
        print(os.path.basename(f), "FAIL", type(e).__name__, e)
