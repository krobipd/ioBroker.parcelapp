# Carrier pictograms

The object tree shows one pictogram per package so the carrier is readable before the name is
(`common.icon` on the device object, inline SVG). Every file here is monochrome
(`currentColor`), drawn on a 64-unit grid for the admin's 28 px row, and uses only `path` and
`circle` — the id-cell CSS of the admin zeroes the width of `rect`, `image`, `use`, nested `svg`
and `foreignObject`.

## Sources

| File               | Source                                                               | Licence of the artwork                    |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------- |
| `apple.svg`        | [simple-icons](https://github.com/simple-icons/simple-icons) 16.31.0 | CC0 1.0 (the project), see the note below |
| `deutschepost.svg` | simple-icons 16.31.0                                                 | CC0 1.0 (the project), see the note below |
| `doordash.svg`     | simple-icons 16.31.0                                                 | CC0 1.0 (the project), see the note below |
| `dpd.svg`          | simple-icons 16.31.0                                                 | CC0 1.0 (the project), see the note below |
| `hermes.svg`       | simple-icons 16.31.0                                                 | CC0 1.0 (the project), see the note below |
| `ups.svg`          | simple-icons 16.31.0                                                 | CC0 1.0 (the project), see the note below |
| `usps.svg`         | simple-icons 16.31.0                                                 | CC0 1.0 (the project), see the note below |
| `vinted.svg`       | simple-icons 16.31.0                                                 | CC0 1.0 (the project), see the note below |
| `amazon.svg`       | drawn for this adapter                                               | MIT, like the rest of the adapter         |
| `dhl.svg`          | drawn for this adapter                                               | MIT, like the rest of the adapter         |
| `gls.svg`          | drawn for this adapter                                               | MIT, like the rest of the adapter         |
| `tnt.svg`          | drawn for this adapter                                               | MIT, like the rest of the adapter         |
| `post.svg`         | drawn for this adapter (envelope, national postal operators)         | MIT, like the rest of the adapter         |
| `truck.svg`        | drawn for this adapter (delivery van, every other carrier)           | MIT, like the rest of the adapter         |

## Trademarks

The shapes identify the carrier of a shipment inside the user's own object tree. They remain the
trademarks of their owners; simple-icons states that the CC0 licence of the project "doesn't mean
to imply that all icons within the project are also CC0" and asks users to seek the correct
permissions for their use. No endorsement by any carrier is claimed or implied, and none of these
marks is used as a logo of this adapter — the adapter's own icon is `admin/parcelapp.svg`.
