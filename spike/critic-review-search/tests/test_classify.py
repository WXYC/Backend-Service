"""Unit tests for the heuristic editorial/retail classifier (classify.py).

These are pure, offline tests -- no network. They pin down the exclusion
rules the ticket names explicitly (Discogs, Bandcamp *store*, Spotify/Apple,
RYM, Last.fm, Genius, retailer blurbs, radio charts) and the one deliberate
carve-out (Bandcamp *Daily* is editorial, not store).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from classify import classify_url, Category  # noqa: E402


def test_discogs_is_excluded():
    result = classify_url("https://www.discogs.com/release/12345-Some-Artist-Some-Album")
    assert result.category == Category.EXCLUDED_DOMAIN
    assert "discogs" in result.reason.lower()


def test_bandcamp_store_page_is_excluded():
    result = classify_url("https://someartist.bandcamp.com/album/some-album")
    assert result.category == Category.EXCLUDED_DOMAIN


def test_bandcamp_daily_is_not_excluded():
    result = classify_url("https://daily.bandcamp.com/album-of-the-day/some-artist-some-album-review")
    assert result.category != Category.EXCLUDED_DOMAIN


def test_spotify_is_excluded():
    result = classify_url("https://open.spotify.com/album/abc123")
    assert result.category == Category.EXCLUDED_DOMAIN


def test_apple_music_is_excluded():
    result = classify_url("https://music.apple.com/us/album/some-album/123456")
    assert result.category == Category.EXCLUDED_DOMAIN


def test_rym_is_excluded():
    result = classify_url("https://rateyourmusic.com/release/album/some-artist/some-album/")
    assert result.category == Category.EXCLUDED_DOMAIN


def test_lastfm_is_excluded():
    result = classify_url("https://www.last.fm/music/Some+Artist/Some+Album")
    assert result.category == Category.EXCLUDED_DOMAIN


def test_genius_is_excluded():
    result = classify_url("https://genius.com/albums/Some-artist/Some-album")
    assert result.category == Category.EXCLUDED_DOMAIN


def test_known_retailer_domain_is_retail():
    result = classify_url("https://www.amazon.com/Some-Album/dp/B000123")
    assert result.category == Category.LIKELY_RETAIL


def test_shop_path_marker_is_retail():
    result = classify_url(
        "https://www.someindielabel.com/shop/some-artist-some-album-vinyl-lp",
        title="Some Artist - Some Album LP",
        snippet="In stock. Ships within 2 business days. Add to cart.",
    )
    assert result.category == Category.LIKELY_RETAIL


def test_editorial_looking_url_is_a_candidate():
    result = classify_url(
        "https://www.pastemagazine.com/music/some-artist/some-album-album-review/",
        title="Some Artist: Some Album Album Review",
        snippet="Some Artist's new record is a bruising, gorgeous listen from start to finish.",
    )
    assert result.category == Category.EDITORIAL_CANDIDATE


def test_long_tail_blog_is_a_candidate_not_excluded():
    # The whole point of Option B: outlets we've never seen before (not on any
    # curated allow-list) must still be reachable as editorial candidates.
    result = classify_url(
        "https://maximumrocknroll.com/reviews/22-beaches-dust-recordings-1980-1984/",
        title="22 Beaches - Dust: Recordings 1980-1984",
        snippet="A blistering collection of early-80s DIY minimal wave.",
    )
    assert result.category == Category.EDITORIAL_CANDIDATE


def test_radio_chart_page_is_retail_like_excluded():
    result = classify_url(
        "https://www.cmj.com/charts/some-artist-some-album-charts-at-12/",
        title="Some Artist charts at #12 this week",
    )
    assert result.category in (Category.LIKELY_RETAIL, Category.EXCLUDED_DOMAIN)


def test_plural_products_path_is_retail():
    # Found live against the fixture sample: boomkat.com/products/... and
    # mrbongo.com/products/... are record-shop product pages, but a strict
    # singular "product" segment match missed the common plural form.
    result = classify_url("https://boomkat.com/products/dust-recordings-1980-1984")
    assert result.category == Category.LIKELY_RETAIL


def test_observed_record_shop_domains_are_retail():
    # Domains empirically observed to be pure vinyl-shop listings during the
    # spike's live validation run against the labeled 40-sample (issue
    # #1873) -- illustrative, not an exhaustive registry. Production should
    # lean on the fetch+LLM stage as the real backstop rather than trying to
    # enumerate every record shop on the internet here.
    shop_urls = [
        "https://www.mrbongo.com/products/22-beaches-dust-recordings-1980-1984-vinyl-lp",
        "https://www.piccadillyrecords.com/155708/22-Beaches-Dust:-Recordings-1980-1984-Seated-Records",
        "https://www.decks.de/track/22_beaches-dust_recordings_1980-1984/cmw-kr/en",
        "https://www.musicmaniarecords.be/6453-22-beaches/15889-dust-recordings-19801984/",
        "https://www.strandedrecords.com/products/k-frimpong-his-cubano-fiestas-the-black-album-lp",
        "https://www.rushhour.nl/record/vinyl/st-887",
    ]
    for url in shop_urls:
        assert classify_url(url).category == Category.LIKELY_RETAIL, url
