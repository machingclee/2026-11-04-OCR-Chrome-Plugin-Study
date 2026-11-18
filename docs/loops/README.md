# Loop records

A record is named `YYYY-MM-DD-NN-slug.md`:

- `YYYY-MM-DD` is the day the loop started, on the operator's clock;
- `NN` is the order the loops started that day, zero-padded (`01`, `02`, …);
- `slug` is the short name of the criterion.

The number is part of the name because a day can hold several loops, and two
records from the same day must sort in the order they ran. Assets stay under
`assets/` and keep their names; a record links them relatively, so moving the
record does not move the images.
