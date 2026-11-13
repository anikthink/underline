// epub2azw3: a spike converter from EPUB to AZW3 (KF8) using github.com/leotaku/mobi.
// Usage: epub2azw3 in.epub out.azw3
package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"hash/fnv"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/leotaku/mobi"
	"golang.org/x/image/draw"
	"golang.org/x/text/language"
)

type opf struct {
	Metadata struct {
		Title    []string `xml:"title"`
		Creator  []string `xml:"creator"`
		Language []string `xml:"language"`
		Meta     []struct {
			Name    string `xml:"name,attr"`
			Content string `xml:"content,attr"`
		} `xml:"meta"`
	} `xml:"metadata"`
	Manifest []struct {
		ID         string `xml:"id,attr"`
		Href       string `xml:"href,attr"`
		MediaType  string `xml:"media-type,attr"`
		Properties string `xml:"properties,attr"`
	} `xml:"manifest>item"`
	Spine struct {
		Toc   string `xml:"toc,attr"`
		Items []struct {
			IDRef  string `xml:"idref,attr"`
			Linear string `xml:"linear,attr"`
		} `xml:"itemref"`
	} `xml:"spine"`
}

type tocEntry struct{ Frag, Title string }

type report struct {
	Title, Author                         string
	Chapters, Images, CSS                 int
	LinksFlattened, ImagesDownscaled      int
	SVGDropped, NestedTOCFlattened        int
	SplitFiles                            int
	BytesIn, BytesOut                     int64
	Seconds                               float64
	Cover                                 bool
	ThumbFile                             string
	Warnings                              []string
}

var (
	reBody    = regexp.MustCompile(`(?is)<body[^>]*>(.*)</body>`)
	reImg     = regexp.MustCompile(`(?is)(<img\b[^>]*?\bsrc=")([^"]+)(")`)
	reSVG     = regexp.MustCompile(`(?is)<svg\b.*?</svg>`)
	reSVGImg  = regexp.MustCompile(`(?is)<image\b[^>]*?(?:xlink:)?href="([^"]+)"`)
	reAnchor  = regexp.MustCompile(`(?is)<a\b([^>]*)>`)
	reHref    = regexp.MustCompile(`(?is)\bhref="([^"]*)"`)
	reFont    = regexp.MustCompile(`(?is)@font-face\s*{[^}]*}`)
	reCSSURL  = regexp.MustCompile(`(?is)url\([^)]*\)`)
	reTag     = regexp.MustCompile(`(?s)<[^>]+>`)
	reHeading = regexp.MustCompile(`(?is)<h[1-3][^>]*>(.*?)</h[1-3]>`)
	reScript  = regexp.MustCompile(`(?is)<script\b.*?</script>`)
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: epub2azw3 in.epub out.azw3")
		os.Exit(2)
	}
	t0 := time.Now()
	rep, err := convert(os.Args[1], os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	rep.Seconds = time.Since(t0).Seconds()
	json.NewEncoder(os.Stdout).Encode(rep)
}

func convert(in, out string) (rep report, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	st, _ := os.Stat(in)
	rep.BytesIn = st.Size()
	zr, err := zip.OpenReader(in)
	if err != nil {
		return rep, err
	}
	defer zr.Close()
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}
	read := func(name string) ([]byte, error) {
		f, ok := files[name]
		if !ok {
			return nil, fmt.Errorf("missing %s", name)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		return io.ReadAll(rc)
	}

	cont, err := read("META-INF/container.xml")
	if err != nil {
		return rep, err
	}
	opfPath := regexp.MustCompile(`full-path="([^"]+)"`).FindStringSubmatch(string(cont))[1]
	base := path.Dir(opfPath)
	raw, err := read(opfPath)
	if err != nil {
		return rep, err
	}
	var o opf
	if err := xml.Unmarshal(raw, &o); err != nil {
		return rep, err
	}
	abs := func(rel, from string) string {
		rel = strings.SplitN(rel, "#", 2)[0]
		return path.Clean(path.Join(from, rel))
	}
	byID := map[string]int{}
	for i, it := range o.Manifest {
		byID[it.ID] = i
	}

	// Table of contents: top-level titles per file. EPUB 3 nav first, then NCX.
	tocTitle := map[string]string{}
	tocFrags := map[string][]tocEntry{}
	for _, it := range o.Manifest {
		if strings.Contains(it.Properties, "nav") {
			b, _ := read(abs(it.Href, base))
			navDir := path.Dir(abs(it.Href, base))
			s := string(b)
			if i := strings.Index(s, `epub:type="toc"`); i > -1 {
				s = s[i:]
				if j := strings.Index(s, "</nav>"); j > -1 {
					s = s[:j]
				}
			}
			depth := 0
			for _, tok := range regexp.MustCompile(`(?is)<ol\b|</ol>|<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>`).FindAllStringSubmatch(s, -1) {
				switch {
				case strings.HasPrefix(strings.ToLower(tok[0]), "<ol"):
					depth++
				case strings.HasPrefix(tok[0], "</"):
					depth--
				default:
					f := abs(tok[1], navDir)
					if depth > 1 {
						rep.NestedTOCFlattened++
					}
					if _, ok := tocTitle[f]; !ok {
						tocTitle[f] = strings.TrimSpace(html2text(tok[2]))
					}
					{
						frag := ""
						if k := strings.Index(tok[1], "#"); k > -1 {
							frag = tok[1][k+1:]
						}
						tocFrags[f] = append(tocFrags[f], tocEntry{frag, strings.TrimSpace(html2text(tok[2]))})
					}
				}
			}
		}
	}
	if len(tocTitle) == 0 && o.Spine.Toc != "" {
		it := o.Manifest[byID[o.Spine.Toc]]
		b, _ := read(abs(it.Href, base))
		ncxDir := path.Dir(abs(it.Href, base))
		for _, m := range regexp.MustCompile(`(?is)<navLabel>\s*<text>(.*?)</text>\s*</navLabel>\s*<content src="([^"]+)"`).FindAllStringSubmatch(string(b), -1) {
			f := abs(m[2], ncxDir)
			if _, ok := tocTitle[f]; !ok {
				tocTitle[f] = strings.TrimSpace(html2text(m[1]))
			}
		}
	}

	// Images, numbered in the order they're first used.
	var images []image.Image
	imgIndex := map[string]int{}
	addImage := func(name string) (int, bool) {
		if i, ok := imgIndex[name]; ok {
			return i, true
		}
		b, err := read(name)
		if err != nil {
			rep.Warnings = append(rep.Warnings, "image missing: "+name)
			return 0, false
		}
		img, _, err := image.Decode(bytes.NewReader(b))
		if err != nil {
			rep.Warnings = append(rep.Warnings, "image unreadable: "+name)
			return 0, false
		}
		if s := fit(img, 1236, 1648); s != nil {
			img = s
			rep.ImagesDownscaled++
		}
		images = append(images, img)
		imgIndex[name] = len(images)
		return len(images), true
	}

	// CSS: every stylesheet in the manifest, without fonts or url() references.
	var css []string
	for _, it := range o.Manifest {
		if it.MediaType == "text/css" {
			b, _ := read(abs(it.Href, base))
			s := reFont.ReplaceAllString(string(b), "")
			s = reCSSURL.ReplaceAllString(s, "none")
			css = append(css, s)
		}
	}
	rep.CSS = len(css)

	var chapters []mobi.Chapter
	for _, ref := range o.Spine.Items {
		it := o.Manifest[byID[ref.IDRef]]
		if !strings.Contains(it.MediaType, "html") {
			continue
		}
		name := abs(it.Href, base)
		dir := path.Dir(name)
		b, err := read(name)
		if err != nil {
			return rep, err
		}
		m := reBody.FindStringSubmatch(string(b))
		if m == nil {
			continue
		}
		body := reScript.ReplaceAllString(m[1], "")
		// SVG wrappers (usually covers): keep the image they show, drop the SVG.
		body = reSVG.ReplaceAllStringFunc(body, func(s string) string {
			rep.SVGDropped++
			if im := reSVGImg.FindStringSubmatch(s); im != nil {
				if n, ok := addImage(abs(im[1], dir)); ok {
					return fmt.Sprintf(`<img src="kindle:embed:%s?mime=image/jpeg" alt=""/>`, to32(n))
				}
			}
			return ""
		})
		body = reImg.ReplaceAllStringFunc(body, func(s string) string {
			p := reImg.FindStringSubmatch(s)
			if strings.HasPrefix(p[2], "kindle:") {
				return s
			}
			if n, ok := addImage(abs(p[2], dir)); ok {
				return p[1] + "kindle:embed:" + to32(n) + "?mime=image/jpeg" + p[3]
			}
			return p[1] + p[3]
		})
		// The library can't write links inside the book, so they become plain text.
		body = reAnchor.ReplaceAllStringFunc(body, func(s string) string {
			h := reHref.FindStringSubmatch(s)
			if h == nil || strings.HasPrefix(h[1], "http") || strings.HasPrefix(h[1], "mailto:") {
				return s
			}
			rep.LinksFlattened++
			return "<a" + reHref.ReplaceAllString(s[2:len(s)-1], "") + ">"
		})
		title := tocTitle[name]
		if title == "" {
			if h := reHeading.FindStringSubmatch(body); h != nil {
				title = strings.TrimSpace(html2text(h[1]))
			}
		}
		if strings.TrimSpace(html2text(body)) == "" && !strings.Contains(body, "<img") {
			continue
		}
		// Several chapters in one file: split at the top-level element holding each TOC anchor.
		parts := splitAtAnchors(body, tocFrags[name])
		if len(parts) > 1 {
			rep.SplitFiles++
			for _, pt := range parts {
				if strings.TrimSpace(html2text(pt.body)) == "" && !strings.Contains(pt.body, "<img") {
					continue
				}
				t := pt.title
				if t == "" {
					t = title
				}
				chapters = append(chapters, mobi.Chapter{Title: t, Chunks: mobi.Chunks(pt.body)})
			}
			continue
		}
		chapters = append(chapters, mobi.Chapter{Title: title, Chunks: mobi.Chunks(body)})
	}
	// Untitled parts (usually the cover or title page) still get a contents entry, so name them.
	for i := range chapters {
		if strings.TrimSpace(chapters[i].Title) == "" {
			if i == 0 {
				chapters[i].Title = first(o.Metadata.Title)
			} else {
				chapters[i].Title = chapters[i-1].Title
			}
		}
	}
	rep.Chapters = len(chapters)

	// Cover: EPUB 3 property, then the EPUB 2 meta.
	var cover image.Image
	coverName := ""
	for _, it := range o.Manifest {
		if strings.Contains(it.Properties, "cover-image") {
			coverName = abs(it.Href, base)
		}
	}
	if coverName == "" {
		for _, mt := range o.Metadata.Meta {
			if mt.Name == "cover" {
				if i, ok := byID[mt.Content]; ok {
					coverName = abs(o.Manifest[i].Href, base)
				}
			}
		}
	}
	if coverName != "" {
		if b, err := read(coverName); err == nil {
			if img, _, err := image.Decode(bytes.NewReader(b)); err == nil {
				if s := fit(img, 1236, 1648); s != nil {
					img = s
				}
				cover = img
				rep.Cover = true
			}
		}
	}

	title, author := first(o.Metadata.Title), first(o.Metadata.Creator)
	rep.Title, rep.Author, rep.Images = title, author, len(images)
	lang, _ := language.Parse(first(o.Metadata.Language))
	h := fnv.New32a()
	h.Write([]byte(title + "\x00" + author))
	book := mobi.Book{
		Title: title, Authors: []string{author}, Language: lang,
		CreatedDate: time.Now(), Chapters: chapters, CSSFlows: css,
		Images: images, CoverImage: cover, UniqueID: h.Sum32(),
	}
	if cover != nil {
		book.ThumbImage = fit(cover, 330, 470)
		if book.ThumbImage == nil {
			book.ThumbImage = cover
		}
	}
	f, err := os.Create(out)
	if err != nil {
		return rep, err
	}
	if err := book.Realize().Write(f); err != nil {
		f.Close()
		return rep, err
	}
	f.Close()
	if st, err := os.Stat(out); err == nil {
		rep.BytesOut = st.Size()
	}
	// Newer Kindles only show a sideloaded book's cover from system/thumbnails.
	if book.ThumbImage != nil {
		rep.ThumbFile = book.GetThumbFilename()
		tf, err := os.Create(path.Join(path.Dir(out), rep.ThumbFile))
		if err == nil {
			jpeg.Encode(tf, book.ThumbImage, &jpeg.Options{Quality: 85})
			tf.Close()
		}
	}
	return rep, nil
}

// fit returns a scaled copy if img is larger than w×h, else nil.
func fit(img image.Image, w, h int) image.Image {
	b := img.Bounds()
	if b.Dx() <= w && b.Dy() <= h {
		return nil
	}
	k := min(float64(w)/float64(b.Dx()), float64(h)/float64(b.Dy()))
	dst := image.NewRGBA(image.Rect(0, 0, int(float64(b.Dx())*k), int(float64(b.Dy())*k)))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
	return dst
}

func to32(n int) string {
	const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUV"
	s := ""
	for n > 0 {
		s = string(digits[n%32]) + s
		n /= 32
	}
	for len(s) < 4 {
		s = "0" + s
	}
	return s
}

func html2text(s string) string { return strings.Join(strings.Fields(reTag.ReplaceAllString(s, " ")), " ") }

func first(s []string) string {
	if len(s) > 0 {
		return s[0]
	}
	return ""
}

type part struct{ title, body string }

var reTagTok = regexp.MustCompile(`(?s)<(/?)([a-zA-Z][a-zA-Z0-9:]*)[^>]*?(/?)>|<!--.*?-->`)

// splitAtAnchors cuts body only at the starts of top-level elements, so every part stays balanced.
func splitAtAnchors(body string, toc []tocEntry) []part {
	if len(toc) < 2 {
		return nil
	}
	var starts []int
	depth := 0
	for _, m := range reTagTok.FindAllStringSubmatchIndex(body, -1) {
		if m[2] < 0 { // comment
			continue
		}
		closing, selfClose := body[m[2]:m[3]] == "/", body[m[6]:m[7]] == "/"
		name := strings.ToLower(body[m[4]:m[5]])
		void := name == "br" || name == "hr" || name == "img" || name == "meta" || name == "link" || name == "input"
		if closing {
			depth--
			continue
		}
		if depth == 0 {
			starts = append(starts, m[0])
		}
		if !selfClose && !void {
			depth++
		}
	}
	type cut struct {
		at    int
		title string
	}
	var cuts []cut
	for _, e := range toc {
		if e.Frag == "" {
			continue
		}
		i := strings.Index(body, `id="`+e.Frag+`"`)
		if i < 0 {
			continue
		}
		at := -1
		for _, s := range starts {
			if s <= i {
				at = s
			}
		}
		if at < 0 || (len(cuts) > 0 && at <= cuts[len(cuts)-1].at) {
			continue
		}
		cuts = append(cuts, cut{at, e.Title})
	}
	if len(cuts) < 2 {
		return nil
	}
	var out []part
	if cuts[0].at > 0 {
		out = append(out, part{"", body[:cuts[0].at]})
	}
	for k, c := range cuts {
		end := len(body)
		if k+1 < len(cuts) {
			end = cuts[k+1].at
		}
		out = append(out, part{c.title, body[c.at:end]})
	}
	return out
}
