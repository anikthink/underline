package main
import ("os";"time";"github.com/leotaku/mobi";"golang.org/x/text/language")
func main(){
 ch := []mobi.Chapter{{Title:"One",Chunks:mobi.Chunks("<p>Hello there.</p>")},{Title:"Two",Chunks:mobi.Chunks("<p>Second chapter.</p>")}}
 b := mobi.Book{Title:"Sample",Authors:[]string{"A"},Language:language.English,CreatedDate:time.Now(),Chapters:ch,UniqueID:42}
 f,_ := os.Create(os.Args[1]); b.Realize().Write(f); f.Close()
}
